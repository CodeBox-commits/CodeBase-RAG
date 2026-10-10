"""Runs a dataset through the real pipeline (databases, embeddings, reranker) and scores it.

Retrieval runs stop before the answer model, so with recorded plans they make no model calls.
Answer runs call the model once or twice per question and are paced to respect rate limits.
"""

import json
import logging
import os
import subprocess
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from eval import metrics
from eval.dataset import Case, Dataset

logger = logging.getLogger("eval")

ROOT = Path(__file__).parent
CACHE = ROOT / "cache"
RESULTS = ROOT / "results"

VARIANTS: dict[str, str] = {
    "full": "The pipeline as configured",
    "no_planner": "No query plan: the raw question is the only query, with no symbols",
    "vector_only": "Vector search only (no BM25)",
    "bm25_only": "BM25 only, over every query and field (no vectors)",
    "no_rerank": "No cross-encoder: the first fused search results are kept",
    "no_graph_expansion": "The graph step adds no extra code to the context",
}

# Kept per hit in saved results: enough to rescore and to see what was retrieved.
_HIT_FIELDS = ("symbol", "filepath", "start_line", "end_line", "sources", "score", "rerank_score", "reason")


def _slim(hits: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{k: h.get(k) for k in _HIT_FIELDS if h.get(k) is not None} for h in hits]


# --- recorded plans --------------------------------------------------------------------------


class MissingPlan(RuntimeError):
    pass


class RecordedPlanner:
    """Stands in for the agent's QueryPlanner: replays saved plans, records new ones.

    The plan is the only model call before retrieval, so replaying it makes retrieval runs
    free, repeatable, and runnable without an API key.
    """

    def __init__(self, path: Path, live: Any | None, delay: float = 0.0):
        self.path = path
        self.live = live
        self.delay = delay
        data = json.loads(path.read_text()) if path.exists() else {}
        self.model: str | None = data.get("model")
        self.plans: dict[str, dict[str, Any]] = data.get("plans", {})
        self.recorded = 0

    def plan(self, question: str, history: list[dict[str, str]] | None = None) -> Any:
        from app.core.schemas import QueryPlan

        key = question.strip()
        if key in self.plans:
            return QueryPlan.model_validate(self.plans[key])
        if self.live is None:
            raise MissingPlan(f"no recorded plan for {key!r}; run once with a GEMINI_API_KEY to record it")
        if self.recorded and self.delay:
            time.sleep(self.delay)
        plan = self.live.plan(question, history)
        self.plans[key] = plan.model_dump()
        self.recorded += 1
        self._save()
        return plan

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        model = os.getenv("LLM_MODEL", "gemini-3.5-flash-lite")
        self.path.write_text(json.dumps({"model": model, "plans": self.plans}, indent=2, sort_keys=True) + "\n")


class _NoPlan:
    def plan(self, question: str, history: list[dict[str, str]] | None = None) -> Any:
        from app.core.schemas import QueryPlan

        return QueryPlan(query_type="general", complexity="simple", symbols=[], queries=[])


# --- the agent and its variants -----------------------------------------------------------


def build_agent(dataset: Dataset, *, record: bool, delay: float) -> Any:
    """The real CodeAgent, with its planner replaced by recorded plans."""
    from app.services.agent import CodeAgent

    live = record and bool(os.getenv("GEMINI_API_KEY"))
    # Retrieval needs no model when every plan is recorded; the agent still wants a key to build.
    os.environ.setdefault("GEMINI_API_KEY", "unused-by-recorded-retrieval")
    agent = CodeAgent()
    agent.query_planner = RecordedPlanner(
        CACHE / f"{dataset.name}-plans.json", agent.query_planner if live else None, delay
    )
    return agent


@contextmanager
def variant(agent: Any, name: str) -> Iterator[None]:
    """Switches one pipeline stage off (or changes it) for an ablation, then restores it."""
    from app.services.agent import hybrid_search_terms
    from app.services.lexical_db import DEFAULT_FIELDS

    if name not in VARIANTS:
        raise ValueError(f"unknown variant {name!r}; choose from {sorted(VARIANTS)}")
    saved = {"reranker": agent.reranker, "config": agent.config, "query_planner": agent.query_planner}
    patched: list[str] = []

    def patch(attr: str, fn: Any) -> None:
        setattr(agent, attr, fn)
        patched.append(attr)

    try:
        if name == "no_planner":
            agent.query_planner = _NoPlan()
        elif name == "vector_only":
            patch("_lexical_plan", lambda state: ([], ()))
        elif name == "bm25_only":
            patch("node_embed_queries", lambda state: {"query_embeddings": [], "errors": list(state.get("errors", []))})
            patch(
                "_lexical_plan",
                lambda state: (
                    hybrid_search_terms(agent._search_queries(state), state.get("symbols", [])),
                    tuple(DEFAULT_FIELDS),
                ),
            )
        elif name == "no_rerank":
            agent.reranker = None
        elif name == "no_graph_expansion":
            agent.config = replace(agent.config, graph_expand_limit=0)
        yield
    finally:
        for attr, value in saved.items():
            setattr(agent, attr, value)
        for attr in patched:
            agent.__dict__.pop(attr, None)


# --- retrieval ------------------------------------------------------------------------------


def retrieve(agent: Any, case: Case, repo_url: str) -> dict[str, Any]:
    """Runs the pipeline up to (not including) the answer, keeping each stage's hits."""
    state: dict[str, Any] = dict(agent._initial_state(case.question, repo_url, None, False))
    for node in (agent.node_query_planner, agent.node_retrieval_router, agent.node_embed_queries, agent.node_retrieve):
        state.update(node(state))
    candidates = list(state.get("vector_results", []))
    state.update(agent.node_rerank(state))
    reranked = list(state.get("vector_results", []))
    state.update(agent.node_graph_search(state))
    expanded = list(state.get("expanded_results", []))
    # Impact questions also get a report listing every affected symbol with its location.
    listed = [
        {
            "symbol": a.get("name"),
            "filepath": a.get("filepath"),
            "start_line": a.get("start_line"),
            "sources": ["impact"],
        }
        for report in state.get("impact_results", [])
        for a in report.get("affected", [])
    ]
    return {
        "plan": {k: state.get(k) for k in ("query_type", "complexity", "symbols", "rewritten_queries")},
        "strategy": state.get("retrieval_strategy"),
        "errors": list(state.get("errors", [])),
        "stages": {
            "candidates": _slim(candidates),
            "reranked": _slim(reranked),
            "context": _slim(reranked + expanded),
            "listed": _slim(listed),
        },
    }


def run_retrieval(agent: Any, dataset: Dataset, variants: list[str], limit: int | None = None) -> dict[str, Any]:
    cases = [c for c in dataset.cases if c.answerable][:limit]
    report: dict[str, Any] = {"variants": {}}
    for name in variants:
        rows = []
        with variant(agent, name):
            for case in cases:
                out = retrieve(agent, case, dataset.repo)
                scores = metrics.retrieval_scores(case, out["stages"])
                rows.append({"id": case.id, "kind": case.kind, **scores, **out})
                logger.info("%-18s %-34s context recall %.2f", name, case.id, scores["context_recall"])
        report["variants"][name] = {
            "description": VARIANTS[name],
            "summary": metrics.summarize([_scores_only(r) for r in rows]),
            "by_kind": _by_kind(rows),
            "cases": rows,
        }
    return report


# --- answers --------------------------------------------------------------------------------


_SPAN_QUERY = """
MATCH (n:Symbol {repo_url: $repo_url})
WHERE (n.qualified_name = $name OR n.qualified_name STARTS WITH $name + '#')
  AND ($filepath IS NULL OR n.filepath = $filepath)
RETURN n.qualified_name AS name, n.filepath AS filepath, n.start_line AS start_line, n.end_line AS end_line
"""


def gold_spans(repo_url: str, case: Case) -> list[dict[str, Any]]:
    """Where each gold symbol is defined in the index (overloads included)."""
    from app.services.graph_db import graph_db

    graph_db.connect()
    spans: list[dict[str, Any]] = []
    with graph_db._require_driver().session() as session:
        for g in case.gold:
            spans += [r.data() for r in session.run(_SPAN_QUERY, repo_url=repo_url, name=g.name, filepath=g.filepath)]
    return spans


def run_answers(
    agent: Any, dataset: Dataset, out_path: Path, *, limit: int | None, delay: float, allow_followup: bool
) -> list[dict[str, Any]]:
    """Asks every question once and appends each raw result to a JSONL file as it arrives.

    An interrupted run resumes where it stopped: cases already in the file are skipped.
    """
    done = {json.loads(line)["id"] for line in out_path.read_text().splitlines()} if out_path.exists() else set()
    todo = [c for c in dataset.cases[:limit] if c.id not in done]
    for i, case in enumerate(todo):
        if i and delay:
            time.sleep(delay)
        started = time.perf_counter()
        result = agent.run(case.question, dataset.repo, allow_followup=allow_followup)
        row = {"id": case.id, **result, "seconds": round(time.perf_counter() - started, 2)}
        with out_path.open("a") as f:
            f.write(json.dumps(row, default=str) + "\n")
        logger.info(
            "answered %-34s %s, %d citations", case.id, result.get("status"), len(result.get("citations") or [])
        )
    return [json.loads(line) for line in out_path.read_text().splitlines()]


def score_answers(dataset: Dataset, raw: list[dict[str, Any]]) -> dict[str, Any]:
    by_id = {c.id: c for c in dataset.cases}
    rows = []
    for r in raw:
        case = by_id.get(r["id"])
        if case is None:
            continue
        spans = gold_spans(dataset.repo, case) if case.answerable else []
        rows.append(
            {"id": case.id, "kind": case.kind, "answerable": case.answerable, **metrics.answer_scores(case, r, spans)}
        )
    answerable = [r for r in rows if r["answerable"]]
    unanswerable = [r for r in rows if not r["answerable"]]
    return {
        "summary": {
            **metrics.summarize([{k: v for k, v in r.items() if k != "abstained"} for r in answerable]),
            # Saying "it isn't there" is right for unanswerable questions and wrong otherwise.
            "false_abstention": metrics.summarize([{"x": r["abstained"]} for r in answerable]).get("x"),
            "unanswerable_cases": len(unanswerable),
            "correct_abstention": metrics.summarize([{"x": r["abstained"]} for r in unanswerable]).get("x"),
        },
        "by_kind": _by_kind(answerable),
        "cases": rows,
    }


# --- shared -----------------------------------------------------------------------------------


def _scores_only(row: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in row.items() if k not in ("stages", "plan", "errors", "missing")}


def _by_kind(rows: list[dict[str, Any]]) -> dict[str, Any]:
    kinds = sorted({r["kind"] for r in rows})
    return {k: metrics.summarize([_scores_only(r) for r in rows if r["kind"] == k]) for k in kinds}


def meta(dataset: Dataset, mode: str) -> dict[str, Any]:
    from app.services.graph_db import graph_db

    graph_db.connect()
    state = graph_db.get_index_state(dataset.repo) or {}
    try:
        code = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, cwd=ROOT
        ).stdout.strip()
    except OSError:
        code = ""
    return {
        "dataset": dataset.name,
        "repo": dataset.repo,
        "mode": mode,
        "labelled_commit": dataset.commit,
        "indexed_commit": state.get("commit"),
        "index_version": state.get("index_version"),
        "code_version": code or os.getenv("GIT_SHA", ""),
        "llm_model": os.getenv("LLM_MODEL", "gemini-3.5-flash-lite"),
        "reranker": os.getenv("RERANKER_MODEL", "ms-marco-MiniLM-L-12-v2"),
        "ran_at": datetime.now(UTC).isoformat(timespec="seconds"),
    }
