import os
import time
import logging
from dataclasses import dataclass
from typing import TypedDict, List, Dict, Any, Iterator, Optional, Tuple
from langgraph.graph import StateGraph, END
from langchain_google_genai import ChatGoogleGenerativeAI
from app.core.schemas import RetrievalStrategy
from app.services.vector_db import vector_db
from app.services.hybrid_search import hybrid_search
from app.services.lexical_db import DEFAULT_FIELDS, LexicalDB
from app.services.query_planner import QueryPlanner
from app.services.embeddings import build_embeddings
from app.services.graph_db import graph_db
from app.services.reranker import CrossEncoderReranker

logger = logging.getLogger(__name__)


def hybrid_search_terms(queries: List[str], symbols: List[str]) -> List[str]:
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
    graph_fanout: int = 10
    max_output_tokens: int = 2048
    # The Google SDK already retries 429/503 with backoff; retrying again here only burns quota.
    llm_retries: int = 0
    llm_retry_backoff_seconds: float = 1.5
 
    @classmethod
    def from_env(cls) -> "AgentConfig":
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "GEMINI_API_KEY is not set. The code agent cannot start without it."
            )
        return cls(
            llm_model=os.getenv("LLM_MODEL", "gemini-3.5-flash-lite"),
            embedding_model=os.getenv("EMBEDDING_MODEL", "models/gemini-embedding-001"),
            api_key=api_key,
            vector_top_k=int(os.getenv("VECTOR_TOP_K", "8")),
            rerank_candidates=int(os.getenv("RERANK_CANDIDATES", "24")),
            vector_score_threshold=float(os.getenv("VECTOR_SCORE_THRESHOLD", "0.25")),
            max_query_embeddings=int(os.getenv("MAX_QUERY_EMBEDDINGS", "3")),
            snippet_max_lines=int(os.getenv("SNIPPET_MAX_LINES", "60")),
            graph_anchor_limit=int(os.getenv("GRAPH_ANCHOR_LIMIT", "15")),
            graph_max_depth=int(os.getenv("GRAPH_MAX_DEPTH", "3")),
            graph_fanout=int(os.getenv("GRAPH_FANOUT", "10")),
            max_output_tokens=int(os.getenv("LLM_MAX_OUTPUT_TOKENS", "2048")),
        )
    
 
class AgentState(TypedDict):
    question: str
    repo_url: str
    query_embeddings: List[List[float]]
    rewritten_queries: List[str]
    query_type: str
    complexity: str
    symbols: List[str]
    vector_results: List[Dict[str, Any]]
    graph_results: List[Dict[str, Any]]
    rerank_info: Dict[str, Any]
    retrieval_strategy: RetrievalStrategy
    errors: List[str]
    answer: str
 
 
class CodeAgent:
    def __init__(self, config: Optional[AgentConfig] = None):
        self.config = config or AgentConfig.from_env()
 
        self.llm = ChatGoogleGenerativeAI(
            model=self.config.llm_model,
            google_api_key=self.config.api_key,
            temperature=0,
            max_output_tokens=self.config.max_output_tokens,
        )
        self.query_planner = QueryPlanner(self.llm)
        self.embeddings = build_embeddings(
            api_key=self.config.api_key,
            model=self.config.embedding_model,
            dimensions=vector_db.vector_size,
        )
        self.reranker = CrossEncoderReranker.from_env()
        self.workflow = self._build_workflow()
 
    def _build_workflow(self) -> Any:
        
        graph = StateGraph(AgentState)
 
        graph.add_node("query_planner", self.node_query_planner)
        graph.add_node("retrieval_router",self.node_retrieval_router,)
        graph.add_node("embed_queries", self.node_embed_queries)
        graph.add_node("retrieve", self.node_retrieve)
        graph.add_node("rerank", self.node_rerank)
        graph.add_node("graph_search", self.node_graph_search)
        graph.add_node("generate_response", self.node_generate_response)

        graph.set_entry_point("query_planner")

        graph.add_edge("query_planner", "retrieval_router")
        graph.add_edge("retrieval_router", "embed_queries")
        graph.add_edge("embed_queries", "retrieve")
        graph.add_edge("retrieve", "rerank")

        graph.add_conditional_edges(
            "rerank",
            self.route_after_retrieval,
            {
                "graph_search": "graph_search",
                "generate_response": "generate_response",
            },
        )
        graph.add_edge("graph_search", "generate_response")
        graph.add_edge("generate_response", END)
 
        return graph.compile()
 
    @staticmethod
    def route_after_retrieval(state: AgentState,) -> str:
        strategy = state["retrieval_strategy"]

        if strategy == "vector":
            return "generate_response"
        
        return "graph_search"
    
    def node_query_planner(self, state: AgentState) -> Dict[str, Any]:
        errors = list(state.get("errors", []))

        try:
            plan = self.query_planner.plan(state["question"])
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

    def node_retrieval_router(self,state: AgentState,) -> Dict[str, Any]:
       query_type = state["query_type"]

       if query_type in ("symbol_lookup","implementation",):
           strategy: RetrievalStrategy = "vector"

       elif query_type == "call_flow":
           strategy = "graph"

       elif query_type in ("dependency","architecture","bug_analysis",
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
        
    def _search_queries(self, state: AgentState) -> List[str]:
        """Original question plus the rewriter's retrieval queries, de-duplicated."""
        queries: List[str] = []
        for q in [state["question"], *state.get("rewritten_queries", [])]:
            q = (q or "").strip()
            if q and q.lower() not in {existing.lower() for existing in queries}:
                queries.append(q)
        return queries[: self.config.max_query_embeddings]

    def _lexical_plan(self, state: AgentState) -> Tuple[List[str], Tuple[str, ...]]:
        symbols = state.get("symbols", [])
        if state["retrieval_strategy"] == "hybrid":
            # Full BM25 over symbol, path and code text using every retrieval query.
            return hybrid_search_terms(self._search_queries(state), symbols), tuple(DEFAULT_FIELDS)
        # Exact names are where embeddings are weakest, so an explicitly named
        # symbol always gets a symbol-field lexical lookup.
        return hybrid_search_terms([], symbols), ("symbol",)

    def node_embed_queries(self, state: AgentState) -> Dict[str, Any]:
        errors = list(state.get("errors", []))
        embeddings: List[List[float]] = []
        try:
            # One batched request for every query; cached queries never reach the API.
            embeddings = self.embeddings.embed_queries(self._search_queries(state))
        except Exception as e:
            logger.error(f"Query embedding failed: {e}")
            errors.append(f"embedding_failed: {e}")
        return {"query_embeddings": embeddings, "errors": errors}
 
    def node_retrieve(self, state: AgentState) -> Dict[str, Any]:
        errors = list(state.get("errors", []))
        embeddings = state.get("query_embeddings") or []
        results: List[Dict[str, Any]] = []

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

    def node_rerank(self, state: AgentState) -> Dict[str, Any]:
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

    def node_graph_search(self, state: AgentState) -> Dict[str, Any]:
        errors = list(state.get("errors", []))
        anchors = [
            {"filepath": item["filepath"], "symbol": item["symbol"]}
            for item in state.get("vector_results", [])
            if item.get("filepath") and item.get("symbol")
        ]
        names = sorted(set(state.get("symbols", [])))

        if not anchors and not names:
            return {"graph_results": [], "errors": errors}

        graph_context: List[Dict[str, Any]] = []
        try:
            graph_db.connect()
            graph_context = graph_db.get_symbol_context(
                repo_url=state["repo_url"],
                anchors=anchors,
                names=names,
                max_depth=self.config.graph_max_depth,
                anchor_limit=self.config.graph_anchor_limit,
                fanout=self.config.graph_fanout,
            )
        except Exception as e:
            logger.error(f"Graph search node failed: {e}", exc_info=True)
            errors.append(f"graph_search_failed: {e}")
 
        return {"graph_results": graph_context, "errors": errors}
 
    def node_generate_response(self, state: AgentState) -> Dict[str, Any]:
        question = state["question"]
        vector_results = state.get("vector_results", [])
        graph_results = state.get("graph_results", [])
        errors = state.get("errors", [])
 
        code_snippets = self._format_code_snippets(vector_results, self.config.snippet_max_lines)
        graph_metadata = self._format_graph_context(graph_results)
 
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
            "4. Prefer concise, technically precise answers over padded explanations. Use "
            "bullet points or short code blocks where they aid clarity."
        )
 
        context_note = ""
        if errors:
            context_note = (
                "\n\n--- Retrieval Notes ---\n"
                "Some retrieval steps had issues, so context below may be incomplete:\n"
                + "\n".join(f"- {e}" for e in errors)
            )
 
        user_content = (
            f"User Question: {question}\n\n"
            f"--- Code Snippets (Vector Search) ---\n{code_snippets or 'No direct matches found.'}\n\n"
            f"--- Structural Graph Context ---\n{graph_metadata or 'No graph relationships retrieved.'}"
            f"{context_note}\n\n"
            "Answer the question using the rules above."
        )
 
        answer = self._invoke_llm_with_retry(system_prompt, user_content)
        return {"answer": answer}
 
    @staticmethod
    def _format_code_snippets(vector_results: List[Dict[str, Any]], max_lines: int = 60) -> str:
       blocks = []

       for v in CodeAgent._drop_nested_hits(vector_results, max_lines):
          code = CodeAgent._truncate_code(v.get("code_text", ""), max_lines)
          loc = (
             f"{v.get('filepath', 'unknown')} "
             f"(Lines {v.get('start_line')}-{v.get('end_line')})"
          )

          blocks.append(
            f"File: {loc}\n"
            f"Symbol: {v.get('symbol', 'unknown')}\n"
            f"Language: {v.get('language', 'unknown')}\n"
            f"Chunk Type: {v.get('chunk_type', 'unknown')}\n"
            f"Relevance Score: {v.get('score', 0):.3f} (via {', '.join(v.get('sources', [])) or 'unknown'})\n"
            f"Code:\n```\n{code}\n```"
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
    def _drop_nested_hits(results: List[Dict[str, Any]], max_lines: int) -> List[Dict[str, Any]]:
        """Drops hits whose code is already shown in full inside another hit, e.g. a nested function.

        Class chunks only carry the class header, never their methods' code, so they can't contain
        another hit; neither can a hit that will be truncated.
        """
        def span(hit: Dict[str, Any]):
            return hit.get("filepath"), hit.get("start_line"), hit.get("end_line")

        containers = [
            span(hit) for hit in results
            if hit.get("chunk_type") != "class"
            and None not in span(hit)
            and len((hit.get("code_text") or "").splitlines()) <= max_lines
        ]

        def is_nested(hit: Dict[str, Any]) -> bool:
            path, start, end = span(hit)
            if start is None or end is None:
                return False
            return any(
                c_path == path and c_start <= start and end <= c_end and (c_start, c_end) != (start, end)
                for c_path, c_start, c_end in containers
            )

        return [hit for hit in results if not is_nested(hit)]
 
    @staticmethod
    def _format_graph_context(graph_results: List[Dict[str, Any]]) -> str:
        def fmt_neighbours(items: List[Dict[str, Any]]) -> str:
            parts = []
            for item in items:
                hops = item.get("hops") or 1
                suffix = "" if hops == 1 else f", {hops} hops"
                parts.append(f"{item.get('name')} ({item.get('filepath')}:{item.get('line')}{suffix})")
            return ", ".join(parts)

        lines = []
        for g in graph_results:
            labels = [l for l in (g.get("node_labels") or []) if l != "Symbol"]
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
            if g.get("calls"):
                line += f" | Calls: {fmt_neighbours(g['calls'])}"
            if g.get("called_by"):
                line += f" | Called by: {fmt_neighbours(g['called_by'])}"
            lines.append(line)
        return "\n".join(lines)
 
 
    def _invoke_llm_with_retry(self, system_prompt: str, user_content: str) -> str:
        last_error: Optional[Exception] = None
        for attempt in range(self.config.llm_retries + 1):
            try:
                response = self.llm.invoke([
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_content},
                ])
                # Gemini 3 returns content as a list of parts; .text flattens it to a string.
                return response.text
            except Exception as e:
                last_error = e
                logger.error(f"Gemini LLM generation failed (attempt {attempt + 1}): {e}")
                if attempt < self.config.llm_retries:
                    time.sleep(self.config.llm_retry_backoff_seconds * (attempt + 1))
 
        # Full error is logged above; the user gets a short, readable reason.
        reason = str(last_error)
        if "RESOURCE_EXHAUSTED" in reason or "429" in reason:
            detail = "the model's rate limit or quota was reached"
        elif "UNAVAILABLE" in reason or "503" in reason:
            detail = "the model is temporarily overloaded"
        else:
            detail = "the language model returned an error"
        return f"I couldn't generate an answer because {detail}. Please try again in a minute."

 
    def _initial_state(self, question: str, repo_url: str) -> AgentState:
        return {
            "question": question,
            "repo_url": repo_url,
            "query_type": "general",
            "complexity": "simple",
            "symbols": [],
            "rewritten_queries": [],
            "query_embeddings": [],
            "vector_results": [],
            "graph_results": [],
            "rerank_info": {},
            "retrieval_strategy": "vector",
            "errors": [],
            "answer": "",
        }

    def run(self, question: str, repo_url: str) -> str:
        final_state = self.workflow.invoke(self._initial_state(question, repo_url))
        return final_state["answer"]

    def run_stream(self, question: str, repo_url: str) -> Iterator[Dict[str, Any]]:
        """Runs the workflow, yielding a UI event as each node finishes, then the answer.

        Events are summaries for visualisation (no embeddings, trimmed code), so the
        client can show what each pipeline step actually did.
        """
        state: Dict[str, Any] = dict(self._initial_state(question, repo_url))
        for update in self.workflow.stream(state, stream_mode="updates"):
            for node, delta in update.items():
                started = time.perf_counter()
                state.update(delta or {})
                if node == "generate_response":
                    yield {"type": "token", "content": state["answer"]}
                    continue
                event = self._summarize_step(node, state)
                event["summary_ms"] = round((time.perf_counter() - started) * 1000, 2)
                yield event

    def _summarize_step(self, node: str, state: Dict[str, Any]) -> Dict[str, Any]:
        data: Dict[str, Any] = {}
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
        elif node == "graph_search":
            data = self._graph_payload(state.get("graph_results", []))
        return {"type": "step", "node": node, "data": data, "errors": list(state.get("errors", []))}

    @staticmethod
    def _graph_payload(graph_results: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Flattens symbol context rows into nodes and typed edges for drawing."""
        nodes: Dict[str, Dict[str, Any]] = {}
        edges: List[Dict[str, Any]] = []

        def add(name: Optional[str], kind: str, filepath: Optional[str] = None, anchor: bool = False) -> Optional[str]:
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
                    edges.append({"source": center, "target": item["name"], "type": "CALLS", "hops": item.get("hops", 1)})
            for item in row.get("called_by") or []:
                if add(item.get("name"), "function", item.get("filepath")):
                    edges.append({"source": item["name"], "target": center, "type": "CALLS", "hops": item.get("hops", 1)})
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

        unique = {(e["source"], e["target"], e["type"]): e for e in edges}
        return {"nodes": list(nodes.values()), "edges": list(unique.values())}
 
 
_agent_instance: Optional[CodeAgent] = None
 
 
def get_agent() -> CodeAgent:
    global _agent_instance
    if _agent_instance is None:
        _agent_instance = CodeAgent()
    return _agent_instance
 