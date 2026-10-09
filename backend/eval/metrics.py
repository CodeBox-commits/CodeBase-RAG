"""Scoring: pure functions over retrieved hits and answers, so they can be unit-tested and
re-run on saved outputs without touching the databases or the model."""

import re
from collections.abc import Iterable, Mapping, Sequence
from statistics import mean
from typing import Any

from eval.dataset import Case, Gold

Hit = Mapping[str, Any]

# Same-named definitions in one file are indexed as `name`, `name#2`, ... (overloads, redefinitions).
_DUPLICATE_SUFFIX = re.compile(r"#\d+$")


def base_name(symbol: str) -> str:
    return _DUPLICATE_SUFFIX.sub("", symbol or "")


def matches(hit: Hit, gold: Gold) -> bool:
    if base_name(str(hit.get("symbol", ""))) != gold.name:
        return False
    return gold.filepath is None or hit.get("filepath") == gold.filepath


def found(gold: Sequence[Gold], hits: Iterable[Hit]) -> list[bool]:
    """For each gold symbol, whether any hit is that symbol."""
    hits = list(hits)
    return [any(matches(h, g) for h in hits) for g in gold]


def recall(gold: Sequence[Gold], hits: Iterable[Hit]) -> float:
    flags = found(gold, hits)
    return sum(flags) / len(flags) if flags else 0.0


def first_rank(gold: Sequence[Gold], hits: Sequence[Hit]) -> int | None:
    """1-based rank of the first hit that is any gold symbol."""
    for rank, hit in enumerate(hits, start=1):
        if any(matches(hit, g) for g in gold):
            return rank
    return None


def retrieval_scores(case: Case, stages: Mapping[str, Sequence[Hit]]) -> dict[str, Any]:
    """Per-case retrieval metrics from the hits each pipeline stage produced.

    stages: "candidates" (fused search results, before reranking), "reranked" (what the
    reranker kept), "context" (reranked plus the code the graph step added: the code the
    answer model is shown) and, optionally, "listed" (symbols named in the prompt without
    their code, such as an impact report's affected symbols).
    """
    candidates, reranked, context = stages["candidates"], stages["reranked"], stages["context"]
    shown = [*context, *stages.get("listed", [])]
    in_context = found(case.gold, shown)
    rank = first_rank(case.gold, reranked)
    return {
        "candidate_recall": recall(case.gold, candidates),
        "reranked_recall": recall(case.gold, reranked),
        "context_recall": sum(in_context) / len(in_context) if in_context else 0.0,
        "all_gold_in_context": all(in_context),
        "first_gold_rank": rank,
        "reciprocal_rank": 1 / rank if rank else 0.0,
        "context_chunks": len(context),
        "context_lines": sum(_lines(h) for h in context),
        "missing": [str(g) for g, ok in zip(case.gold, in_context, strict=True) if not ok],
    }


def _lines(hit: Hit) -> int:
    start, end = hit.get("start_line"), hit.get("end_line")
    return int(end) - int(start) + 1 if start is not None and end is not None else 0


# --- answers -------------------------------------------------------------------------------

_ABSTAIN = re.compile(
    r"(isn'?t|is not|aren'?t|are not|wasn'?t|was not|not)\s+(?:\w+\s+){0,3}"
    r"(in|present|included|shown|found|available|provided|defined|implemented|contain)"
    r"|no (code|information|mention|definition|implementation|evidence|such)"
    r"|does(?:n'?t| not) (contain|include|show|define|mention|appear|exist|implement|have)"
    r"|(not|cannot|can'?t) (be )?(determine|answer|find|confirm|see)"
    r"|insufficient|not enough (information|context)",
    re.IGNORECASE,
)


def mention_score(case: Case, answer: str) -> float | None:
    """Share of the expected facts the answer states (any phrasing of each fact counts)."""
    if not case.mention:
        return None
    text = answer.lower()
    return sum(any(p.lower() in text for p in fact) for fact in case.mention) / len(case.mention)


def abstained(answer: str) -> bool:
    """Whether the answer says the code or information isn't there (heuristic, English only)."""
    return bool(_ABSTAIN.search(answer))


def cites_gold(citations: Sequence[Mapping[str, Any]], gold_spans: Sequence[Mapping[str, Any]]) -> bool:
    """Whether any citation points inside the code of a gold symbol."""
    for c in citations:
        for span in gold_spans:
            same_file = c.get("filepath") == span["filepath"] or str(span["filepath"]).endswith(
                "/" + str(c.get("filepath"))
            )
            if same_file and span["start_line"] <= int(c.get("line", -1)) <= span["end_line"]:
                return True
    return False


def answer_scores(case: Case, result: Mapping[str, Any], gold_spans: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    citations = result.get("citations") or []
    backed = [c for c in citations if c.get("status") in ("verified", "graph")]
    answer = result.get("answer") or ""
    return {
        "status": result.get("status"),
        "citations": len(citations),
        "citation_validity": len(backed) / len(citations) if citations else None,
        "cites_gold": cites_gold(citations, gold_spans) if case.answerable else None,
        "mention": mention_score(case, answer) if case.answerable else None,
        # An unanswerable question is handled well when the answer says so.
        "abstained": abstained(answer),
        "asked_for_more": bool(result.get("followups")),
        "seconds": result.get("seconds"),
    }


# --- aggregation -------------------------------------------------------------------------

# Averaging a rank over only the cases that found something hides the misses; MRR covers it.
_NOT_AVERAGED = {"first_gold_rank"}


def summarize(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Means of every numeric or boolean metric across rows (None values are skipped)."""
    keys = sorted(
        {k for r in rows for k, v in r.items() if isinstance(v, (int, float, bool)) and k not in _NOT_AVERAGED}
    )
    out: dict[str, Any] = {"cases": len(rows)}
    for key in keys:
        values = [float(r[key]) for r in rows if isinstance(r.get(key), (int, float, bool))]
        if values:
            out[key] = round(mean(values), 4)
    return out
