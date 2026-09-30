import os
import time
import logging
from dataclasses import dataclass
from typing import TypedDict, List, Dict, Any, Optional
from langgraph.graph import StateGraph, END
from langchain_google_genai import ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings
from app.core.schemas import RetrievalStrategy
from app.services.vector_db import vector_db
from app.services.hybrid_search import hybrid_search
from app.services.lexical_db import DEFAULT_FIELDS, LexicalDB
from app.services.query_analyzer import QueryAnalyzer
from app.services.query_rewriter import QueryRewriter
from app.services.graph_db import graph_db

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
    vector_score_threshold: float = 0.25
    max_query_embeddings: int = 4
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
            vector_score_threshold=float(os.getenv("VECTOR_SCORE_THRESHOLD", "0.25")),
            max_query_embeddings=int(os.getenv("MAX_QUERY_EMBEDDINGS", "4")),
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
        self.query_analyzer = QueryAnalyzer(self.llm)
        self.query_rewriter = QueryRewriter(self.llm)
        self.embeddings = GoogleGenerativeAIEmbeddings(
            model=self.config.embedding_model,
            google_api_key=self.config.api_key,
            output_dimensionality=vector_db.vector_size,
        )
        self.workflow = self._build_workflow()
 
    def _build_workflow(self) -> Any:
        
        graph = StateGraph(AgentState)
 
        graph.add_node("query_analyzer", self.node_query_analyzer)
        graph.add_node("query_rewriter", self.node_query_rewriter)
        graph.add_node("retrieval_router",self.node_retrieval_router,)
        graph.add_node("embed_queries", self.node_embed_queries)
        graph.add_node("retrieve", self.node_retrieve)
        graph.add_node("graph_search", self.node_graph_search)
        graph.add_node("generate_response", self.node_generate_response)

        graph.set_entry_point("query_analyzer")

        graph.add_edge("query_analyzer", "query_rewriter")
        graph.add_edge("query_rewriter", "retrieval_router")
        graph.add_edge("retrieval_router", "embed_queries")
        graph.add_edge("embed_queries", "retrieve")

        graph.add_conditional_edges(
            "retrieve",
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
    
    def node_query_analyzer(self, state: AgentState) -> Dict[str, Any]:
       errors = list(state.get("errors", []))

       try:
         analysis = self.query_analyzer.analyze(state["question"])

         logger.info(
             "Query analyzed: type=%s complexity=%s symbols=%s",
             analysis.query_type,
             analysis.complexity,
             analysis.symbols,
         )

         return {
             "query_type": analysis.query_type,
             "complexity": analysis.complexity,
             "symbols": analysis.symbols,
             "errors": errors,
          }

       except Exception as e:
         logger.error(
             "Query analyzer node failed: %s",
             e,
             exc_info=True,
         ) 

         errors.append(f"query_analysis_failed: {e}")

         return {
              "query_type": "general",
              "complexity": "simple",
              "symbols": [],
              "errors": errors,
          }
       
    def node_query_rewriter(self, state: AgentState) -> Dict[str, Any]:
        errors = list(state.get("errors", []))

        try:
           rewrite = self.query_rewriter.rewrite(
              question=state["question"],
              query_type=state["query_type"],
              complexity=state["complexity"],
              symbols=state["symbols"],
          )
 
           logger.info(
              "Rewritten queries: %s",
              rewrite.queries,
           )

           return {
             "rewritten_queries": rewrite.queries,
             "errors": errors,
          }

        except Exception as e:
            logger.error(
             "Query rewriting node failed: %s",
             e,
             exc_info=True,
         )

            errors.append(f"query_rewrite_failed: {e}")

            return {
              "rewritten_queries": [state["question"]],
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

    def node_embed_queries(self, state: AgentState) -> Dict[str, Any]:
        errors = list(state.get("errors", []))
        embeddings: List[List[float]] = []
        for query in self._search_queries(state):
            try:
                embeddings.append(self.embeddings.embed_query(query))
            except Exception as e:
                logger.error(f"Query embedding failed for {query!r}: {e}")
                errors.append(f"embedding_failed: {e}")
        return {"query_embeddings": embeddings, "errors": errors}
 
    def node_retrieve(self, state: AgentState) -> Dict[str, Any]:
        errors = list(state.get("errors", []))
        embeddings = state.get("query_embeddings") or []
        strategy = state["retrieval_strategy"]
        symbols = state.get("symbols", [])
        results: List[Dict[str, Any]] = []

        if strategy == "hybrid":
            # Full BM25 over symbol, path and code text using every retrieval query.
            lexical_terms = hybrid_search_terms(self._search_queries(state), symbols)
            lexical_fields = DEFAULT_FIELDS
        else:
            # Exact names are where embeddings are weakest, so an explicitly named
            # symbol always gets a symbol-field lexical lookup.
            lexical_terms = hybrid_search_terms([], symbols)
            lexical_fields = ("symbol",)

        if not embeddings and not lexical_terms:
            errors.append("retrieval_skipped: no query embeddings or lexical terms available")
            return {"vector_results": results, "errors": errors}

        try:
            results = hybrid_search.search(
                query_vectors=embeddings,
                lexical_terms=lexical_terms,
                repo_url=state["repo_url"],
                limit=self.config.vector_top_k,
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
 
        code_snippets = self._format_code_snippets(vector_results)
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
    def _format_code_snippets(vector_results: List[Dict[str, Any]]) -> str:
       blocks = []

       for v in vector_results:
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
            f"Code:\n```\n{v.get('code_text', '')}\n```"
         )

       return "\n\n".join(blocks)
 
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

 
    def run(self, question: str, repo_url: str) -> str:
     initial_state: AgentState = {
         "question": question,
         "repo_url": repo_url,
         "query_type": "general",
         "complexity": "simple",
         "symbols": [],
         "rewritten_queries": [],
         "query_embeddings": [],
         "vector_results": [],
         "graph_results": [],
         "retrieval_strategy": "vector",
         "errors": [],
         "answer": "",
     }

     final_state = self.workflow.invoke(initial_state)
     return final_state["answer"]
 
 
_agent_instance: Optional[CodeAgent] = None
 
 
def get_agent() -> CodeAgent:
    global _agent_instance
    if _agent_instance is None:
        _agent_instance = CodeAgent()
    return _agent_instance
 