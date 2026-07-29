import os
import time
import logging
from dataclasses import dataclass
from typing import TypedDict, List, Dict, Any, Optional
from langgraph.graph import StateGraph, END
from langchain_google_genai import ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings
from app.services.vector_db import vector_db
from app.services.query_analyzer import QueryAnalyzer
from app.services.query_rewriter import QueryRewriter
from app.services.graph_db import graph_db

logger = logging.getLogger(__name__)
 
@dataclass(frozen=True)
class AgentConfig:
    llm_model: str
    embedding_model: str
    api_key: str
    vector_top_k: int = 8
    vector_score_threshold: float = 0.25
    graph_hop_limit: int = 15
    max_output_tokens: int = 2048
    llm_retries: int = 2
    llm_retry_backoff_seconds: float = 1.5
 
    @classmethod
    def from_env(cls) -> "AgentConfig":
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "GEMINI_API_KEY is not set. The code agent cannot start without it."
            )
        return cls(
            llm_model=os.getenv("LLM_MODEL", "gemini-1.5-flash"),
            embedding_model=os.getenv("EMBEDDING_MODEL", "models/text-embedding-004"),
            api_key=api_key,
            vector_top_k=int(os.getenv("VECTOR_TOP_K", "8")),
            vector_score_threshold=float(os.getenv("VECTOR_SCORE_THRESHOLD", "0.25")),
            graph_hop_limit=int(os.getenv("GRAPH_HOP_LIMIT", "15")),
            max_output_tokens=int(os.getenv("LLM_MAX_OUTPUT_TOKENS", "2048")),
        )
    
 
class AgentState(TypedDict):
    question: str
    repo_url: str
    question_embedding: Optional[List[float]]
    rewritten_queries: List[str]
    query_type: str
    complexity: str
    symbols: List[str]
    vector_results: List[Dict[str, Any]]
    graph_results: List[Dict[str, Any]]
    needs_graph_search: bool
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
        )
        self.workflow = self._build_workflow()
 
    def _build_workflow(self) -> Any:
        
        graph = StateGraph(AgentState)
 
        graph.add_node("query_analyzer", self.node_query_analyzer)
        graph.add_node("query_rewriter", self.node_query_rewriter)
        graph.add_node("embed_question", self.node_embed_question)
        graph.add_node("vector_search", self.node_vector_search)
        graph.add_node("graph_search", self.node_graph_search)
        graph.add_node("generate_response", self.node_generate_response)
 
        graph.set_entry_point("query_analyzer")

        graph.add_edge("query_analyzer", "embed_question")
        graph.add_edge("query_rewriter", "embed_question")
        graph.add_edge("embed_question", "vector_search")
 
        graph.add_conditional_edges(
            "vector_search",
            self.route_after_vector_search,
            {
                "graph_search": "graph_search",
                "generate_response": "generate_response",
            },
        )
        graph.add_edge("graph_search", "generate_response")
        graph.add_edge("generate_response", END)
 
        return graph.compile()
 
    @staticmethod
    def route_after_vector_search(state: AgentState) -> str:
        return "graph_search" if state.get("needs_graph_search") else "generate_response"
    
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
        
    def node_embed_question(self, state: AgentState) -> Dict[str, Any]:
        errors = list(state.get("errors", []))
        embedding: Optional[List[float]] = None
        try:
            embedding = self.embeddings.embed_query(state["question"])
        except Exception as e:
            logger.error(f"Question embedding failed: {e}")
            errors.append(f"embedding_failed: {e}")
        return {"question_embedding": embedding, "errors": errors}
 
    def node_vector_search(self, state: AgentState) -> Dict[str, Any]:
        errors = list(state.get("errors", []))
        embedding = state.get("question_embedding")
 
        if embedding is None:
            errors.append("vector_search_skipped: no question embedding available")
            return {"vector_results": [], "needs_graph_search": False, "errors": errors}
 
        results: List[Dict[str, Any]] = []
        try:
            vector_db.connect(vector_size=len(embedding))
            search_hits = vector_db.client.search(
                collection_name=vector_db.collection_name,
                query_vector=embedding,
                query_filter=self._build_repo_filter(state["repo_url"]),
                limit=self.config.vector_top_k,
                score_threshold=self.config.vector_score_threshold,
            )
            results = [
                {
                  "symbol": hit.payload.get("symbol"),
                  "filepath": hit.payload.get("filepath"),
                  "language": hit.payload.get("language"),
                  "chunk_type": hit.payload.get("chunk_type"),
                  "start_line": hit.payload.get("start_line"),
                  "end_line": hit.payload.get("end_line"),
                  "code_text": hit.payload.get("code_text", ""),
                  "score": hit.score,
               }
             for hit in search_hits
         ]
        except Exception as e:
            logger.error(f"Vector search node failed: {e}")
            errors.append(f"vector_search_failed: {e}")
 
        symbols_present = any(r.get("symbol") for r in results)
        return {
            "vector_results": results,
            "needs_graph_search": symbols_present,
            "errors": errors,
        }
 
    @staticmethod
    def _build_repo_filter(repo_url: str) -> Optional[Dict[str, Any]]:
        if not repo_url:
            return None
        return {
            "must": [
                {"key": "repo_url", "match": {"value": repo_url}}
            ]
        }
 
    def node_graph_search(self, state: AgentState) -> Dict[str, Any]:
        errors = list(state.get("errors", []))
        repo_url = state["repo_url"]
        vector_results = state.get("vector_results", [])
        symbols = sorted({item["symbol"] for item in vector_results if item.get("symbol")})
 
        if not symbols:
            return {"graph_results": [], "errors": errors}
 
        graph_db.connect()
        if not graph_db.driver:
            errors.append("graph_search_skipped: no graph db connection")
            return {"graph_results": [], "errors": errors}
        query = """
        MATCH (r:Repository {url: $repo_url})-[:CONTAINS_CLASS|CONTAINS_FUNCTION*1..2]->(n)
        WHERE n.name IN $symbols
        OPTIONAL MATCH (n)-[:CALLS]->(callee)
        OPTIONAL MATCH (caller)-[:CALLS]->(n)
        RETURN
            labels(n)          AS node_labels,
            n.name              AS name,
            n.filepath          AS filepath,
            n.start_line        AS start_line,
            n.docstring         AS docstring,
            collect(DISTINCT callee.name)  AS calls,
            collect(DISTINCT caller.name)  AS called_by
        LIMIT $limit
        """
        graph_context: List[Dict[str, Any]] = []
        try:
            with graph_db.driver.session() as session:
                res = session.run(
                    query,
                    repo_url=repo_url,
                    symbols=symbols,
                    limit=self.config.graph_hop_limit,
                )
                graph_context = [record.data() for record in res]
        except Exception as e:
            logger.error(f"Graph search node failed: {e}")
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
            f"Relevance Score: {v.get('score', 0):.3f}\n"
            f"Code:\n```\n{v.get('code_text', '')}\n```"
         )

       return "\n\n".join(blocks)
 
    @staticmethod
    def _format_graph_context(graph_results: List[Dict[str, Any]]) -> str:
        lines = []
        for g in graph_results:
            label = "/".join(g.get("node_labels") or []) or "Node"
            line = (
                f"{label} '{g.get('name')}' defined in {g.get('filepath')} "
                f"(Line {g.get('start_line')})"
            )
            if g.get("docstring"):
                line += f" | Docstring: {g['docstring']}"
            for rel_key, rel_label in (
                ("calls", "Calls"),
                ("called_by", "Called by"),
            ):
                values = [v for v in (g.get(rel_key) or []) if v]
                if values:
                    line += f" | {rel_label}: {', '.join(values)}"
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
                return response.content
            except Exception as e:
                last_error = e
                logger.error(f"Gemini LLM generation failed (attempt {attempt + 1}): {e}")
                if attempt < self.config.llm_retries:
                    time.sleep(self.config.llm_retry_backoff_seconds * (attempt + 1))
 
        return (
            "I couldn't generate an answer due to a repeated error contacting the "
            f"language model: {last_error}. Please try again shortly."
        )

 
    def run(self, question: str, repo_url: str) -> str:
     initial_state: AgentState = {
         "question": question,
         "repo_url": repo_url,
         "query_type": "general",
         "complexity": "simple",
         "symbols": [],
         "rewritten_queries": [],
         "question_embedding": None,
         "vector_results": [],
         "graph_results": [],
         "needs_graph_search": False,
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
 