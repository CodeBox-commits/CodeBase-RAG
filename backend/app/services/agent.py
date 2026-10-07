import logging
import os
import re
import time
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from typing import Any, Literal, TypedDict

from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.graph import END, StateGraph

from app.core.schemas import RetrievalStrategy
from app.services import citations as citation_check
from app.services import code_intel
from app.services.embeddings import EmbeddingSettings
from app.services.graph_db import graph_db
from app.services.hybrid_search import hybrid_search
from app.services.lexical_db import DEFAULT_FIELDS, LexicalDB, lexical_db
from app.services.query_planner import QueryPlanner

logger = logging.getLogger(__name__)


def hybrid_search_terms(queries: list[str], symbols: list[str]) -> list[str]:
    # Symbols first so they survive the term cap.
    return LexicalDB.extract_terms([*symbols, *queries])


@dataclass(frozen=True)
class AgentConfig:
    llm_model: str
    embedding_model: str
    api_key: str
    vector_top_k: int = 8
    # Retrieval gathers this many candidates; the reranker keeps the best vector_top_k.
    rerank_candidates: int = 24
    vector_score_threshold: float = 0.25
    # Original question plus up to two planner rewrites.
    max_query_embeddings: int = 3
    # Per-snippet cap in the answer prompt; code snippets dominate its input tokens.
    snippet_max_lines: int = 60
    graph_anchor_limit: int = 15
    graph_max_depth: int = 3
    # Symbol/implementation questions ("vector" strategy) only need the immediate neighbourhood.
    graph_shallow_depth: int = 1
    graph_fanout: int = 10
    # Code pulled in through the graph (overrides, named symbols, direct callees) on top of the hits.
    graph_expand_limit: int = 6
    # Impact questions: how far back to walk dependents, and how many to list per symbol.
    impact_depth: int = 3
    impact_max_symbols: int = 60
    max_output_tokens: int = 2048
    # Tried when the main model is rate-limited or overloaded (it has its own quota). The Google
    # SDK already retries 429/503 with backoff before we get here.
    llm_fallback_model: str | None = None
    # Follow-up questions: how many earlier messages the planner and the answer prompt see.
    history_messages: int = 6
    history_answer_chars: int = 1200
    # Ask-for-more: how many times the model may request missing code before it must answer,
    # how many items one request may name, and how many chunks each item brings back.
    followup_rounds: int = 1
    followup_max_items: int = 5
    followup_chunks_per_item: int = 2

    @classmethod
    def from_env(cls) -> "AgentConfig":
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY is not set. The code agent cannot start without it.")
        return cls(
            llm_model=os.getenv("LLM_MODEL", "gemini-3.5-flash-lite"),
            embedding_model=EmbeddingSettings.from_env().model,
            api_key=api_key,
            vector_top_k=int(os.getenv("VECTOR_TOP_K", "8")),
            rerank_candidates=int(os.getenv("RERANK_CANDIDATES", "24")),
            vector_score_threshold=float(os.getenv("VECTOR_SCORE_THRESHOLD", "0.25")),
            max_query_embeddings=int(os.getenv("MAX_QUERY_EMBEDDINGS", "3")),
            snippet_max_lines=int(os.getenv("SNIPPET_MAX_LINES", "60")),
            graph_anchor_limit=int(os.getenv("GRAPH_ANCHOR_LIMIT", "15")),
            graph_max_depth=int(os.getenv("GRAPH_MAX_DEPTH", "3")),
            graph_fanout=int(os.getenv("GRAPH_FANOUT", "10")),
            graph_expand_limit=int(os.getenv("GRAPH_EXPAND_LIMIT", "6")),
            max_output_tokens=int(os.getenv("LLM_MAX_OUTPUT_TOKENS", "2048")),
            llm_fallback_model=os.getenv("LLM_FALLBACK_MODEL") or None,
            followup_rounds=int(os.getenv("AGENT_FOLLOWUP_ROUNDS", "1")),
        )


AnswerStatus = Literal["ok", "fallback_model", "degraded"]


class AgentResult(TypedDict):
    answer: str
    # Every `path:line` in the answer, checked against the context (see services/citations.py).
    citations: list[dict[str, Any]]
    # ok | fallback_model (main model unavailable) | degraded (no model: retrieved code listed)
    status: AnswerStatus
    # Ask-for-more rounds: what the model requested and what was found for it.
    followups: list[dict[str, Any]]


class AgentState(TypedDict):
    question: str
    repo_url: str
    # Earlier messages of this conversation ({"role", "content"}), oldest first.
    history: list[dict[str, str]]
    query_embeddings: list[list[float]]
    rewritten_queries: list[str]
    query_type: str
    complexity: str
    symbols: list[str]
    vector_results: list[dict[str, Any]]
    graph_results: list[dict[str, Any]]
    # Code of related symbols the graph found but search didn't return, each with a "reason".
    expanded_results: list[dict[str, Any]]
    # "What breaks if X changes": dependents of each named symbol, from code_intel.impact.
    impact_results: list[dict[str, Any]]
    rerank_info: dict[str, Any]
    retrieval_strategy: RetrievalStrategy
    errors: list[str]
    answer: str
    citations: list[dict[str, Any]]
    answer_status: AnswerStatus
    # Ask-for-more: allowed for this question, rounds used, items pending, history of rounds.
    allow_followup: bool
    followup_round: int
    requested: list[str]
    followups: list[dict[str, Any]]


class CodeAgent:
    def __init__(self, config: AgentConfig | None = None):
        self.config = config or AgentConfig.from_env()

        self.llm = ChatGoogleGenerativeAI(
            model=self.config.llm_model,
            google_api_key=self.config.api_key,
            temperature=0,
            max_output_tokens=self.config.max_output_tokens,
        )
        self.fallback_llm = (
            ChatGoogleGenerativeAI(
                model=self.config.llm_fallback_model,
                google_api_key=self.config.api_key,
                temperature=0,
                max_output_tokens=self.config.max_output_tokens,
            )
            if self.config.llm_fallback_model
            else None
        )
        self.query_planner = QueryPlanner(self.llm)
        # Shared with search_code and the MCP server: one copy of each model per process.
        self.embeddings = code_intel.get_embeddings()
        self.reranker = code_intel.get_reranker()
        self.workflow = self._build_workflow()

    def _build_workflow(self) -> Any:

        graph = StateGraph(AgentState)

        graph.add_node("query_planner", self.node_query_planner)
        graph.add_node(
            "retrieval_router",
            self.node_retrieval_router,
        )
        graph.add_node("embed_queries", self.node_embed_queries)
        graph.add_node("retrieve", self.node_retrieve)
        graph.add_node("rerank", self.node_rerank)
        graph.add_node("graph_search", self.node_graph_search)
        graph.add_node("generate_response", self.node_generate_response)
        graph.add_node("fetch_more", self.node_fetch_more)

        graph.set_entry_point("query_planner")

        graph.add_edge("query_planner", "retrieval_router")
        graph.add_edge("retrieval_router", "embed_queries")
        graph.add_edge("embed_queries", "retrieve")
        graph.add_edge("retrieve", "rerank")
        # The graph step always runs: even a "where is X" question needs X's overrides and
        # direct callees. The strategy only decides how deep it walks.
        graph.add_edge("rerank", "graph_search")
        graph.add_edge("graph_search", "generate_response")
        # Ask-for-more: a draft that names missing code goes round once more with it.
        graph.add_conditional_edges(
            "generate_response",
            lambda state: "fetch_more" if state.get("requested") else END,
            {"fetch_more": "fetch_more", END: END},
        )
        graph.add_edge("fetch_more", "generate_response")

        return graph.compile()

    def node_query_planner(self, state: AgentState) -> dict[str, Any]:
        errors = list(state.get("errors", []))

        try:
            plan = self.query_planner.plan(state["question"], state.get("history") or None)
        except Exception as e:
            logger.error("Query planner node failed: %s", e, exc_info=True)
            errors.append(f"query_planning_failed: {e}")
            # The original question is always searched, so retrieval still has something to go on.
            return {
                "query_type": "general",
                "complexity": "simple",
                "symbols": [],
                "rewritten_queries": [],
                "errors": errors,
            }

        logger.info(
            "Query planned: type=%s complexity=%s symbols=%s queries=%s",
            plan.query_type,
            plan.complexity,
            plan.symbols,
            plan.queries,
        )
        return {
            "query_type": plan.query_type,
            "complexity": plan.complexity,
            "symbols": plan.symbols,
            "rewritten_queries": plan.queries,
            "errors": errors,
        }

    def node_retrieval_router(
        self,
        state: AgentState,
    ) -> dict[str, Any]:
        query_type = state["query_type"]

        if query_type in (
            "symbol_lookup",
            "implementation",
        ):
            strategy: RetrievalStrategy = "vector"

        elif query_type in ("call_flow", "impact"):
            strategy = "graph"

        elif query_type in (
            "dependency",
            "architecture",
            "bug_analysis",
        ):
            strategy = "hybrid"

        else:
            strategy = "vector"

        logger.info(
            "Retrieval strategy selected: %s",
            strategy,
        )

        return {
            "retrieval_strategy": strategy,
        }

    def _search_queries(self, state: Mapping[str, Any]) -> list[str]:
        """Original question plus the rewriter's retrieval queries, de-duplicated."""
        queries: list[str] = []
        for q in [state["question"], *state.get("rewritten_queries", [])]:
            q = (q or "").strip()
            if q and q.lower() not in {existing.lower() for existing in queries}:
                queries.append(q)
        return queries[: self.config.max_query_embeddings]

    def _lexical_plan(self, state: Mapping[str, Any]) -> tuple[list[str], tuple[str, ...]]:
        symbols = state.get("symbols", [])
        if state["retrieval_strategy"] == "hybrid":
            # Full BM25 over symbol, path and code text using every retrieval query.
            return hybrid_search_terms(self._search_queries(state), symbols), tuple(DEFAULT_FIELDS)
        # Exact names are where embeddings are weakest, so an explicitly named
        # symbol always gets a symbol-field lexical lookup.
        return hybrid_search_terms([], symbols), ("symbol",)

    def node_embed_queries(self, state: AgentState) -> dict[str, Any]:
        errors = list(state.get("errors", []))
        embeddings: list[list[float]] = []
        try:
            # One batched request for every query; cached queries never reach the API.
            embeddings = self.embeddings.embed_queries(self._search_queries(state))
        except Exception as e:
            logger.error(f"Query embedding failed: {e}")
            errors.append(f"embedding_failed: {e}")
        return {"query_embeddings": embeddings, "errors": errors}

    def node_retrieve(self, state: AgentState) -> dict[str, Any]:
        errors = list(state.get("errors", []))
        embeddings = state.get("query_embeddings") or []
        results: list[dict[str, Any]] = []

        lexical_terms, lexical_fields = self._lexical_plan(state)

        if not embeddings and not lexical_terms:
            errors.append("retrieval_skipped: no query embeddings or lexical terms available")
            return {"vector_results": results, "errors": errors}

        try:
            results = hybrid_search.search(
                query_vectors=embeddings,
                lexical_terms=lexical_terms,
                repo_url=state["repo_url"],
                limit=self._candidate_limit(),
                score_threshold=self.config.vector_score_threshold,
                lexical_fields=lexical_fields,
            )
        except Exception as e:
            logger.error(f"Retrieval failed: {e}", exc_info=True)
            errors.append(f"retrieval_failed: {e}")

        return {
            "vector_results": results,
            "errors": errors,
        }

    def _candidate_limit(self) -> int:
        reranker = getattr(self, "reranker", None)
        return max(self.config.rerank_candidates, self.config.vector_top_k) if reranker else self.config.vector_top_k

    def node_rerank(self, state: AgentState) -> dict[str, Any]:
        errors = list(state.get("errors", []))
        candidates = state.get("vector_results", [])
        reranker = getattr(self, "reranker", None)
        if reranker is None:
            return {
                "vector_results": candidates[: self.config.vector_top_k],
                "rerank_info": {"applied": False, "candidates": len(candidates), "error": "reranker disabled"},
            }
        results, info = reranker.rerank(state["question"], candidates, self.config.vector_top_k)
        if info.get("error"):
            errors.append(f"rerank_skipped: {info['error']}")
        logger.info("Reranked %d candidates -> %d (applied=%s)", len(candidates), len(results), info.get("applied"))
        return {"vector_results": results, "rerank_info": info, "errors": errors}

    def node_graph_search(self, state: AgentState) -> dict[str, Any]:
        errors = list(state.get("errors", []))
        anchors = [
            {"filepath": item["filepath"], "symbol": item["symbol"]}
            for item in state.get("vector_results", [])
            if item.get("filepath") and item.get("symbol")
        ]
        names = sorted(set(state.get("symbols", [])))

        if not anchors and not names:
            return {"graph_results": [], "expanded_results": [], "errors": errors}

        shallow = state.get("retrieval_strategy") == "vector"
        graph_context: list[dict[str, Any]] = []
        try:
            graph_db.connect()
            graph_context = graph_db.get_symbol_context(
                repo_url=state["repo_url"],
                anchors=anchors,
                names=names,
                max_depth=self.config.graph_shallow_depth if shallow else self.config.graph_max_depth,
                anchor_limit=self.config.graph_anchor_limit,
                fanout=self.config.graph_fanout,
            )
        except Exception as e:
            logger.error(f"Graph search node failed: {e}", exc_info=True)
            errors.append(f"graph_search_failed: {e}")

        expanded: list[dict[str, Any]] = []
        refs = self.expansion_refs(
            state.get("vector_results", []), graph_context, names, self.config.graph_expand_limit
        )
        if refs:
            try:
                reasons = {(r["filepath"], r["symbol"]): r["reason"] for r in refs}
                for hit in lexical_db.get_chunks(state["repo_url"], refs):
                    expanded.append(
                        {**hit, "sources": ["graph"], "reason": reasons.get((hit["filepath"], hit["symbol"]), "")}
                    )
            except Exception as e:
                logger.error(f"Fetching graph-related code failed: {e}", exc_info=True)
                errors.append(f"graph_expansion_failed: {e}")

        impact_results: list[dict[str, Any]] = []
        if state.get("query_type") == "impact":
            for name in names[:3]:
                try:
                    report = code_intel.impact(
                        state["repo_url"],
                        name,
                        depth=self.config.impact_depth,
                        max_symbols=self.config.impact_max_symbols,
                    )
                except Exception as e:
                    logger.error(f"Impact analysis failed for {name}: {e}", exc_info=True)
                    errors.append(f"impact_failed: {name}: {e}")
                    continue
                if report is not None:
                    impact_results.append(report)

        return {
            "graph_results": graph_context,
            "expanded_results": expanded,
            "impact_results": impact_results,
            "errors": errors,
        }

    @staticmethod
    def expansion_refs(
        hits: list[dict[str, Any]],
        graph_rows: list[dict[str, Any]],
        names: list[str],
        limit: int,
    ) -> list[dict[str, Any]]:
        """Related symbols whose code should be shown although search didn't return it.

        In priority order:
        1. symbols named in the question (search may rank them below the cut-off),
        2. overrides of retrieved methods, both ways: calling a base method can run a
           subclass's version, and a subclass method often defers to its base,
        3. direct callees of the top three hits, where the next step of the logic usually is.
        """
        seen = {(h.get("filepath"), h.get("symbol")) for h in hits}
        wanted = {n.lower() for n in names}
        top = [(h.get("filepath"), h.get("symbol")) for h in hits[:3]]
        refs: list[dict[str, Any]] = []

        def add(symbol: str | None, filepath: str | None, line: int | None, reason: str) -> None:
            key = (filepath, symbol)
            if not symbol or not filepath or line is None or key in seen:
                return
            seen.add(key)
            refs.append({"filepath": filepath, "symbol": symbol, "start_line": line, "reason": reason})

        for row in graph_rows:
            name = row.get("name") or ""
            if name.lower() in wanted or name.rsplit(".", 1)[-1].lower() in wanted:
                add(name, row.get("filepath"), row.get("start_line"), "named in the question")
        for row in graph_rows:
            for item in row.get("overridden_by") or []:
                add(item.get("name"), item.get("filepath"), item.get("line"), f"overrides {row.get('name')}")
            for item in row.get("overrides") or []:
                add(item.get("name"), item.get("filepath"), item.get("line"), f"overridden by {row.get('name')}")
        for row in graph_rows:
            if (row.get("filepath"), row.get("name")) not in top:
                continue
            for item in row.get("calls") or []:
                if (item.get("hops") or 1) == 1:
                    add(item.get("name"), item.get("filepath"), item.get("line"), f"called by {row.get('name')}")
        return refs[:limit]

    def node_generate_response(self, state: AgentState) -> dict[str, Any]:
        question = state["question"]
        vector_results = state.get("vector_results", [])
        graph_results = state.get("graph_results", [])
        expanded_results = state.get("expanded_results", [])
        errors = state.get("errors", [])

        code_snippets = self._format_code_snippets(vector_results, self.config.snippet_max_lines)
        related_snippets = self._format_code_snippets(expanded_results, self.config.snippet_max_lines)
        graph_metadata = self._format_graph_context(graph_results)
        impact_text = self._format_impact(state.get("impact_results", []))

        history = state.get("history") or []
        can_ask = self._can_ask_for_more(state)
        system_prompt = (
            "You are a senior software engineer acting as a code assistant for a specific "
            "repository. You answer using ONLY the context provided below (vector-retrieved "
            "code snippets and graph-derived structural metadata) plus ordinary programming "
            "knowledge for interpreting it. Do not invent files, symbols, or line numbers that "
            "are not present in the context.\n\n"
            "Rules:\n"
            "1. Every factual claim about the codebase must cite a file path and line number "
            "from the context, formatted as `path/to/file.py:line`.\n"
            "2. If the context does not contain enough information to answer confidently, say "
            "so explicitly and state what additional information (which files, symbols, or "
            "search terms) would help, instead of guessing.\n"
            "3. When describing relationships (calls, inheritance, imports), use the structural "
            "graph context rather than inferring it from the snippet text alone.\n"
            "4. When a method is overridden in a subclass, check which version actually runs for "
            "the object in question; the override's behaviour usually decides the answer.\n"
            "5. For impact questions, the Impact Analysis section is computed exactly from the "
            "call graph: base the list of affected code on it (grouped by file, closest first), "
            "It already includes super() calls, subclasses and overrides. Add one short caveat that "
            "calls the graph can't resolve statically (dynamic dispatch, external code) aren't listed.\n"
            "6. The question may follow up on the conversation so far: use it to resolve what "
            "'it' or 'that' refers to, but cite only from the context below.\n"
            "7. Prefer concise, technically precise answers over padded explanations. Use "
            "bullet points or short code blocks where they aid clarity."
        ) + (
            "\n8. If answering correctly needs code that is NOT in the context (for example a "
            "function that is called but not shown), do not guess. Reply with exactly one line, "
            "`NEED: <name>, <name>`, naming up to "
            f"{self.config.followup_max_items} functions, classes, methods or file paths, and "
            "nothing else. You can ask once; the code is then added and you answer."
            if can_ask
            else ""
        )

        context_note = ""
        if errors:
            context_note = (
                "\n\n--- Retrieval Notes ---\n"
                "Some retrieval steps had issues, so context below may be incomplete:\n"
                + "\n".join(f"- {e}" for e in errors)
            )

        conversation = self._format_history(history, self.config.history_answer_chars)
        user_content = (
            (f"--- Conversation So Far ---\n{conversation}\n\n" if conversation else "")
            + f"User Question: {question}\n\n"
            f"--- Code Snippets (Vector Search) ---\n{code_snippets or 'No direct matches found.'}\n\n"
            f"--- Related Code (pulled in via the graph) ---\n{related_snippets or 'None.'}\n\n"
            f"--- Structural Graph Context ---\n{graph_metadata or 'No graph relationships retrieved.'}"
            + (f"\n\n--- Impact Analysis (exact, from the call graph) ---\n{impact_text}" if impact_text else "")
            + f"{context_note}\n\n"
            "Answer the question using the rules above."
        )

        answer, status, failure = self._generate(system_prompt, user_content)
        if answer is None:
            answer = self._degraded_answer(failure, vector_results, expanded_results)
        elif (requested := self.parse_request(answer, self.config.followup_max_items)) is not None:
            if can_ask and requested:
                logger.info("Model asked for more context: %s", requested)
                return {"requested": requested, "answer": ""}
            # Asked anyway on the last round: tell the user what was missing instead.
            answer = (
                "The retrieved context wasn't enough to answer this reliably. It would need: "
                + ", ".join(f"`{r}`" for r in requested)
                + ". Try asking about those directly."
            )

        spans = [
            *citation_check.snippet_spans(vector_results, self.config.snippet_max_lines),
            *citation_check.snippet_spans(expanded_results, self.config.snippet_max_lines),
            *citation_check.graph_spans(graph_results, state.get("impact_results", [])),
        ]
        citations = citation_check.check_citations(answer, spans)
        summary = citation_check.summarize(citations)
        if summary["total"] - summary["verified"] - summary["graph"]:
            logger.warning("Answer has unsupported citations: %s", summary)
        return {"answer": answer, "citations": citations, "answer_status": status, "requested": []}

    def _can_ask_for_more(self, state: Mapping[str, Any]) -> bool:
        return bool(state.get("allow_followup", True)) and state.get("followup_round", 0) < self.config.followup_rounds

    _REQUEST_RE = re.compile(r"^[\s*_`>]*NEED\s*:\s*(.*)", re.DOTALL)

    @classmethod
    def parse_request(cls, text: str, max_items: int) -> list[str] | None:
        """Items of a `NEED: a, b` reply, or None when the text is an answer."""
        match = cls._REQUEST_RE.match(text or "")
        if match is None:
            return None
        items: list[str] = []
        for raw in re.split(r"[,;\n]", match.group(1)):
            item = raw.strip().rstrip(".").strip("`*_'\" ")
            if item and len(item) <= 200 and item not in items:
                items.append(item)
        return items[:max_items]

    @staticmethod
    def looks_like_request(prefix: str) -> bool:
        """Whether a streamed answer's first characters are a `NEED:` request (kept from the UI)."""
        return prefix.lstrip(" \n*_`>").upper().startswith("NEED")

    def node_fetch_more(self, state: AgentState) -> dict[str, Any]:
        """Fetches what the model asked for: exact symbols first, search when no symbol matches."""
        repo_url = state["repo_url"]
        errors = list(state.get("errors", []))
        expanded = list(state.get("expanded_results", []))
        seen = {(h.get("filepath"), h.get("symbol")) for h in [*state.get("vector_results", []), *expanded]}
        per_item = self.config.followup_chunks_per_item
        found_log: list[dict[str, Any]] = []
        anchors: list[dict[str, str]] = []

        for item in state.get("requested", []):
            hits: list[dict[str, Any]] = []
            try:
                is_path = "/" in item or bool(re.search(r"\.\w{1,4}$", item))
                if not is_path:
                    hits = code_intel.get_symbol_code(repo_url, item)[:per_item]
                if not hits:
                    hits = code_intel.search_code(repo_url, item, limit=per_item)
            except Exception as e:
                logger.error(f"Fetching requested context failed for {item}: {e}", exc_info=True)
                errors.append(f"fetch_more_failed: {item}: {e}")
            added = []
            for hit in hits:
                key = (hit.get("filepath"), hit.get("symbol"))
                if key in seen:
                    continue
                seen.add(key)
                expanded.append({**hit, "sources": ["requested"], "reason": f"requested by the model: {item}"})
                anchors.append({"filepath": str(hit.get("filepath")), "symbol": str(hit.get("symbol"))})
                added.append({k: hit.get(k) for k in ("symbol", "filepath", "start_line", "end_line")})
            found_log.append({"item": item, "found": added})

        # The new symbols' callers, callees and overrides, so the answer can place them.
        graph_results = list(state.get("graph_results", []))
        if anchors:
            try:
                known = {(r.get("filepath"), r.get("name")) for r in graph_results}
                for row in graph_db.get_symbol_context(
                    repo_url=repo_url, anchors=anchors, names=[], max_depth=1, fanout=self.config.graph_fanout
                ):
                    if (row.get("filepath"), row.get("name")) not in known:
                        graph_results.append(row)
            except Exception as e:
                errors.append(f"fetch_more_graph_failed: {e}")

        round_no = state.get("followup_round", 0) + 1
        return {
            "expanded_results": expanded,
            "graph_results": graph_results,
            "followup_round": round_no,
            "requested": [],
            "followups": [*state.get("followups", []), {"round": round_no, "items": found_log}],
            "errors": errors,
        }

    @staticmethod
    def _format_history(history: list[dict[str, str]], answer_chars: int) -> str:
        lines = []
        for turn in history:
            text = (turn.get("content") or "").strip()
            if turn.get("role") != "user" and len(text) > answer_chars:
                text = text[:answer_chars] + " ..."
            lines.append(f"{'User' if turn.get('role') == 'user' else 'Assistant'}: {text}")
        return "\n\n".join(lines)

    @staticmethod
    def _degraded_answer(reason: str, hits: list[dict[str, Any]], related: list[dict[str, Any]]) -> str:
        """No model available: still show what retrieval found, with real citations."""
        found = [h for h in [*hits, *related] if h.get("filepath") and h.get("start_line")][:10]
        head = f"**I couldn't generate an answer because {reason}.**"
        if not found:
            return f"{head} Retrieval found no matching code either. Please try again in a minute."
        lines = [f"{head} Here is the code retrieval found for your question, most relevant first:", ""]
        for h in found:
            why = f" ({h['reason']})" if h.get("reason") else ""
            lines.append(f"- `{h['filepath']}:{h['start_line']}` {h.get('symbol', '')}{why}")
        return "\n".join(lines)

    @staticmethod
    def _format_code_snippets(vector_results: list[dict[str, Any]], max_lines: int = 60) -> str:
        blocks = []

        for v in CodeAgent._drop_nested_hits(vector_results, max_lines):
            code = CodeAgent._truncate_code(v.get("code_text", ""), max_lines)
            loc = f"{v.get('filepath', 'unknown')} (Lines {v.get('start_line')}-{v.get('end_line')})"

            blocks.append(
                f"File: {loc}\n"
                f"Symbol: {v.get('symbol', 'unknown')}\n"
                f"Language: {v.get('language', 'unknown')}\n"
                f"Chunk Type: {v.get('chunk_type', 'unknown')}\n"
                + (
                    f"Why included: {v['reason']}\n"
                    if v.get("reason")
                    else f"Relevance Score: {v.get('score', 0):.3f} (via {', '.join(v.get('sources', [])) or 'unknown'})\n"
                )
                + f"Code:\n```\n{code}\n```"
            )

        return "\n\n".join(blocks)

    @staticmethod
    def _truncate_code(code: str, max_lines: int) -> str:
        # Keeps the head: signature and docstring say the most, and line citations stay valid.
        lines = code.splitlines()
        if len(lines) <= max_lines:
            return code
        return "\n".join(lines[:max_lines]) + f"\n# ... {len(lines) - max_lines} more lines not shown"

    @staticmethod
    def _drop_nested_hits(results: list[dict[str, Any]], max_lines: int) -> list[dict[str, Any]]:
        """Drops hits whose code is already shown in full inside another hit, e.g. a nested function.

        Class chunks only carry the class header, never their methods' code, so they can't contain
        another hit; neither can a hit that will be truncated.
        """

        def span(hit: dict[str, Any]):
            return hit.get("filepath"), hit.get("start_line"), hit.get("end_line")

        containers = [
            span(hit)
            for hit in results
            if hit.get("chunk_type") != "class"
            and None not in span(hit)
            and len((hit.get("code_text") or "").splitlines()) <= max_lines
        ]

        def is_nested(hit: dict[str, Any]) -> bool:
            path, start, end = span(hit)
            if start is None or end is None:
                return False
            return any(
                c_path == path and c_start <= start and end <= c_end and (c_start, c_end) != (start, end)
                for c_path, c_start, c_end in containers
            )

        return [hit for hit in results if not is_nested(hit)]

    @staticmethod
    def _format_impact(reports: list[dict[str, Any]], per_report: int = 40) -> str:
        blocks = []
        for r in reports:
            targets = ", ".join(f"{t['name']} ({t['filepath']}:{t['start_line']})" for t in r["targets"])
            head = (
                f"Changing {r['name']} [{targets}] can affect {r['total']} symbols across "
                f"{len(r['files'])} files (up to {r['depth']} hops"
                + (", list truncated)" if r.get("truncated") else ")")
            )
            lines = [head]
            for a in r["affected"][:per_report]:
                lines.append(
                    f"- {a['name']} ({a['filepath']}:{a['start_line']}) {a['relation']} "
                    f"{a['via']['name']}, {a['hops']} hop{'s' if a['hops'] > 1 else ''} away"
                )
            if r["total"] > per_report:
                lines.append(f"- ... and {r['total'] - per_report} more")
            blocks.append("\n".join(lines))
        return "\n\n".join(blocks)

    @staticmethod
    def _format_graph_context(graph_results: list[dict[str, Any]]) -> str:
        def fmt_neighbours(items: list[dict[str, Any]]) -> str:
            parts = []
            for item in items:
                hops = item.get("hops") or 1
                suffix = "" if hops == 1 else f", {hops} hops"
                parts.append(f"{item.get('name')} ({item.get('filepath')}:{item.get('line')}{suffix})")
            return ", ".join(parts)

        lines = []
        for g in graph_results:
            labels = [lbl for lbl in (g.get("node_labels") or []) if lbl != "Symbol"]
            label = "Method" if "Method" in labels else (labels[0] if labels else "Node")
            line = (
                f"{label} '{g.get('name')}' defined in {g.get('filepath')} "
                f"(Lines {g.get('start_line')}-{g.get('end_line')})"
            )
            if g.get("owner"):
                line += f" | Member of class: {g['owner']}"
            if g.get("docstring"):
                line += f" | Docstring: {g['docstring']}"
            for key, title in (("bases", "Inherits from"), ("subclasses", "Subclassed by"), ("methods", "Methods")):
                values = [v for v in (g.get(key) or []) if v]
                if values:
                    line += f" | {title}: {', '.join(values)}"
            for key, title in (("overrides", "Overrides"), ("overridden_by", "Overridden by")):
                if g.get(key):
                    line += f" | {title}: {fmt_neighbours(g[key])}"
            if g.get("calls"):
                line += f" | Calls: {fmt_neighbours(g['calls'])}"
            if g.get("called_by"):
                line += f" | Called by: {fmt_neighbours(g['called_by'])}"
            lines.append(line)
        return "\n".join(lines)

    def _generate(self, system_prompt: str, user_content: str) -> tuple[str | None, AnswerStatus, str]:
        """(answer, status, failure reason). The fallback model is only tried for capacity errors."""
        messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_content}]
        attempts: list[tuple[AnswerStatus, Any]] = [("ok", self.llm)]
        if getattr(self, "fallback_llm", None) is not None:
            attempts.append(("fallback_model", self.fallback_llm))
        reason = "the language model returned an error"
        for status, llm in attempts:
            try:
                # Gemini 3 returns content as a list of parts; .text flattens it to a string.
                return llm.invoke(messages).text, status, ""
            except Exception as e:
                logger.error(f"LLM generation failed ({status}): {e}")
                text = str(e)
                if "RESOURCE_EXHAUSTED" in text or "429" in text:
                    reason = "the model's rate limit or quota was reached"
                elif "UNAVAILABLE" in text or "503" in text:
                    reason = "the model is temporarily overloaded"
                else:
                    reason = "the language model returned an error"
                    break  # not a capacity problem: another model won't fix it
        return None, "degraded", reason

    def _initial_state(
        self,
        question: str,
        repo_url: str,
        history: list[dict[str, str]] | None = None,
        allow_followup: bool = True,
    ) -> AgentState:
        return {
            "question": question,
            "repo_url": repo_url,
            "history": list(history or [])[-self.config.history_messages :],
            "query_type": "general",
            "complexity": "simple",
            "symbols": [],
            "rewritten_queries": [],
            "query_embeddings": [],
            "vector_results": [],
            "graph_results": [],
            "expanded_results": [],
            "impact_results": [],
            "rerank_info": {},
            "retrieval_strategy": "vector",
            "errors": [],
            "answer": "",
            "citations": [],
            "answer_status": "ok",
            "allow_followup": allow_followup,
            "followup_round": 0,
            "requested": [],
            "followups": [],
        }

    def run(
        self,
        question: str,
        repo_url: str,
        history: list[dict[str, str]] | None = None,
        allow_followup: bool = True,
    ) -> AgentResult:
        final = self.workflow.invoke(self._initial_state(question, repo_url, history, allow_followup))
        return {
            "answer": final["answer"],
            "citations": final["citations"],
            "status": final["answer_status"],
            "followups": final["followups"],
        }

    def run_stream(
        self,
        question: str,
        repo_url: str,
        history: list[dict[str, str]] | None = None,
        allow_followup: bool = True,
    ) -> Iterator[dict[str, Any]]:
        """Runs the workflow, yielding events as it goes:

        - {"type": "step"}   once per pipeline step, a summary for visualisation
        - {"type": "token"}  answer text as the model writes it (deltas, to append)
        - {"type": "answer"} the final answer with checked citations; replaces the streamed text
          (it differs when the fallback model or the no-model answer took over)
        """
        state: dict[str, Any] = dict(self._initial_state(question, repo_url, history, allow_followup))
        # Each generation round holds its first characters back until it's clear whether
        # they start an answer (streamed) or a `NEED:` request (never shown).
        held, decided, hidden = "", False, False
        for mode, chunk in self.workflow.stream(state, stream_mode=["updates", "messages"]):
            if mode == "messages":
                message, metadata = chunk
                # Only the answer: the planner's structured-output call streams through here too.
                if metadata.get("langgraph_node") != "generate_response":
                    continue
                text = getattr(message, "text", "")
                if not isinstance(text, str) or not text:
                    continue
                if decided:
                    if not hidden:
                        yield {"type": "token", "content": text}
                    continue
                held += text
                if len(held.lstrip(" \n*_`>")) >= 4:
                    decided, hidden = True, self.looks_like_request(held)
                    if not hidden:
                        yield {"type": "token", "content": held}
                continue
            for node, delta in chunk.items():
                started = time.perf_counter()
                state.update(delta or {})
                if node == "generate_response":
                    held, decided, hidden = "", False, False
                    if state.get("requested"):
                        # A request, not an answer: the fetch_more step event follows.
                        continue
                    yield {
                        "type": "answer",
                        "content": state["answer"],
                        "citations": state["citations"],
                        "status": state["answer_status"],
                    }
                    continue
                event = self._summarize_step(node, state)
                event["summary_ms"] = round((time.perf_counter() - started) * 1000, 2)
                yield event

    def _summarize_step(self, node: str, state: dict[str, Any]) -> dict[str, Any]:
        data: dict[str, Any] = {}
        if node == "query_planner":
            data = {
                "query_type": state["query_type"],
                "complexity": state["complexity"],
                "symbols": state["symbols"],
                "queries": self._search_queries(state),
            }
        elif node == "retrieval_router":
            data = {"strategy": state["retrieval_strategy"]}
        elif node == "embed_queries":
            vectors = state.get("query_embeddings") or []
            data = {
                "queries": self._search_queries(state)[: len(vectors)],
                "dimensions": len(vectors[0]) if vectors else 0,
                # A short signature of each vector for a visual "fingerprint".
                "previews": [[round(v, 4) for v in vec[:24]] for vec in vectors],
            }
        elif node == "retrieve":
            terms, fields = self._lexical_plan(state)
            data = {
                "lexical_terms": terms,
                "lexical_fields": list(fields),
                "vector_lists": len(state.get("query_embeddings") or []),
                "results": [
                    {
                        "symbol": r.get("symbol"),
                        "filepath": r.get("filepath"),
                        "start_line": r.get("start_line"),
                        "end_line": r.get("end_line"),
                        "chunk_type": r.get("chunk_type"),
                        "score": r.get("score"),
                        "rrf_score": r.get("rrf_score"),
                        "vector_score": r.get("vector_score"),
                        "bm25_score": r.get("bm25_score"),
                        "sources": r.get("sources", []),
                    }
                    for r in state.get("vector_results", [])
                ],
            }
        elif node == "rerank":
            info = state.get("rerank_info") or {}
            data = {
                **{k: info.get(k) for k in ("model", "applied", "candidates", "ms", "weight", "error")},
                "kept": len(state.get("vector_results", [])),
                "results": [
                    {
                        "symbol": r.get("symbol"),
                        "filepath": r.get("filepath"),
                        "start_line": r.get("start_line"),
                        "chunk_type": r.get("chunk_type"),
                        "score": r.get("score"),
                        "rerank_score": r.get("rerank_score"),
                        "retrieval_score": r.get("retrieval_score"),
                        "retrieval_rank": r.get("retrieval_rank"),
                        "sources": r.get("sources", []),
                    }
                    for r in state.get("vector_results", [])
                ],
            }
        elif node == "fetch_more":
            data = state["followups"][-1] if state.get("followups") else {}
        elif node == "graph_search":
            data = self._graph_payload(state.get("graph_results", []))
            data["depth"] = (
                self.config.graph_shallow_depth
                if state.get("retrieval_strategy") == "vector"
                else self.config.graph_max_depth
            )
            data["impact"] = [
                {k: r.get(k) for k in ("name", "depth", "total", "truncated", "files")}
                for r in state.get("impact_results", [])
            ]
            data["expanded"] = [
                {k: r.get(k) for k in ("symbol", "filepath", "start_line", "end_line", "chunk_type", "reason")}
                for r in state.get("expanded_results", [])
            ]
        return {"type": "step", "node": node, "data": data, "errors": list(state.get("errors", []))}

    @staticmethod
    def _graph_payload(graph_results: list[dict[str, Any]]) -> dict[str, Any]:
        """Flattens symbol context rows into nodes and typed edges for drawing."""
        nodes: dict[str, dict[str, Any]] = {}
        edges: list[dict[str, Any]] = []

        def add(name: str | None, kind: str, filepath: str | None = None, anchor: bool = False) -> str | None:
            if not name:
                return None
            node = nodes.setdefault(name, {"id": name, "kind": kind, "filepath": filepath, "anchor": False})
            node["anchor"] = node["anchor"] or anchor
            if filepath and not node.get("filepath"):
                node["filepath"] = filepath
            return name

        for row in graph_results:
            labels = row.get("node_labels") or []
            kind = "class" if "Class" in labels else "method" if "Method" in labels else "function"
            center = add(row.get("name"), kind, row.get("filepath"), anchor=True)
            if not center:
                continue
            for item in row.get("calls") or []:
                if add(item.get("name"), "function", item.get("filepath")):
                    edges.append(
                        {"source": center, "target": item["name"], "type": "CALLS", "hops": item.get("hops", 1)}
                    )
            for item in row.get("called_by") or []:
                if add(item.get("name"), "function", item.get("filepath")):
                    edges.append(
                        {"source": item["name"], "target": center, "type": "CALLS", "hops": item.get("hops", 1)}
                    )
            if add(row.get("owner"), "class"):
                edges.append({"source": row["owner"], "target": center, "type": "HAS_METHOD", "hops": 1})
            for base in row.get("bases") or []:
                if add(base, "class"):
                    edges.append({"source": center, "target": base, "type": "INHERITS", "hops": 1})
            for sub in row.get("subclasses") or []:
                if add(sub, "class"):
                    edges.append({"source": sub, "target": center, "type": "INHERITS", "hops": 1})
            for method in row.get("methods") or []:
                if add(method, "method"):
                    edges.append({"source": center, "target": method, "type": "HAS_METHOD", "hops": 1})
            for item in row.get("overridden_by") or []:
                if add(item.get("name"), "method", item.get("filepath")):
                    edges.append({"source": item["name"], "target": center, "type": "OVERRIDES", "hops": 1})
            for item in row.get("overrides") or []:
                if add(item.get("name"), "method", item.get("filepath")):
                    edges.append({"source": center, "target": item["name"], "type": "OVERRIDES", "hops": 1})

        unique = {(e["source"], e["target"], e["type"]): e for e in edges}
        return {"nodes": list(nodes.values()), "edges": list(unique.values())}


_agent_instance: CodeAgent | None = None


def get_agent() -> CodeAgent:
    global _agent_instance
    if _agent_instance is None:
        _agent_instance = CodeAgent()
    return _agent_instance
