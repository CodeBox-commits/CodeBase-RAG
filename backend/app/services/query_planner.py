import logging

from langchain_google_genai import ChatGoogleGenerativeAI

from app.core.schemas import QueryPlan

logger = logging.getLogger(__name__)

_PROMPT = """
You plan retrieval for an AI codebase question-answering system.
Do NOT answer the question. Only describe it and produce search queries.

Return four fields:

1. query_type: exactly ONE of
   - symbol_lookup: where a specific function, class, method, variable or other symbol is defined
   - implementation: what a specific piece of code does or how it is implemented
   - dependency: what calls, uses, imports or depends on a symbol (or what it depends on)
   - call_flow: execution flow, data flow or interactions across multiple functions/components
   - architecture: high-level structure, organization or design of the repository
   - bug_analysis: investigating a bug, failure, error or unexpected behavior
   - impact: what could break or need updating if a symbol is changed, renamed or removed
   - general: a repository question that fits none of the above

2. complexity:
   - "simple" when one symbol, one code location or a little local context likely answers it
   - "complex" when it likely needs multiple files, components, relationships or multi-step reasoning

3. symbols: code symbols the user explicitly mentioned (functions, methods, classes, variables,
   modules, service/component identifiers). Never invent symbols. Do not include generic
   programming concepts unless they are clearly used as a named repository component.

4. queries: ONE or TWO concise search queries for retrieving source code.
   - Preserve every explicit symbol exactly as written.
   - Prefer technical terms likely to appear in source code.
   - No conversational paraphrases, no invented function/class/variable names.
   - If the question is already an excellent search query, return it unchanged.


Examples:

"Where is process_repository defined?"
-> symbol_lookup, simple, symbols=["process_repository"],
   queries=["process_repository definition"]

"What calls validate_token?"
-> dependency, simple, symbols=["validate_token"],
   queries=["validate_token callers", "validate_token references"]

"Explain how CodeAgent retrieves code from Qdrant and uses Neo4j."
-> call_flow, complex, symbols=["CodeAgent", "Qdrant", "Neo4j"],
   queries=["CodeAgent Qdrant vector search", "CodeAgent Neo4j graph query"]

"How is this backend architected?"
-> architecture, complex, symbols=[],
   queries=["application entry point routers services", "backend module structure"]

"What breaks if I change the signature of hybrid_search.search?"
-> impact, complex, symbols=["hybrid_search.search"],
   queries=["hybrid_search.search callers", "hybrid_search.search usage"]

"Why could repository indexing fail?"
-> bug_analysis, complex, symbols=[],
   queries=["repository indexing error handling", "ingestion failure exception"]


{history}USER QUESTION:

{question}
"""

_HISTORY = """CONVERSATION SO FAR (oldest first). The question may refer back to it ("it", "that
function", "its callers"): resolve those references, and put the resolved symbol names in
`symbols` and `queries`. Classify and plan the NEW question only.

{turns}

"""

# Earlier turns only need to identify what's being talked about.
_TURN_CHARS = 500


class QueryPlanner:
    """Classifies the question, extracts symbols and writes retrieval queries in one LLM call."""

    def __init__(self, llm: ChatGoogleGenerativeAI):
        self.structured_llm = llm.with_structured_output(QueryPlan)

    def plan(self, question: str, history: list[dict[str, str]] | None = None) -> QueryPlan:
        # Errors propagate so the agent node can record them and fall back.
        result = self.structured_llm.invoke(_PROMPT.format(question=question, history=format_history(history)))
        # with_structured_output(QueryPlan) returns a QueryPlan; dicts only appear with include_raw.
        if not isinstance(result, QueryPlan):
            result = QueryPlan.model_validate(result)
        return result


def format_history(history: list[dict[str, str]] | None, max_chars: int = _TURN_CHARS) -> str:
    if not history:
        return ""
    turns = []
    for turn in history:
        text = " ".join((turn.get("content") or "").split())
        if len(text) > max_chars:
            text = text[:max_chars] + "..."
        turns.append(f"{'User' if turn.get('role') == 'user' else 'Assistant'}: {text}")
    return _HISTORY.format(turns="\n".join(turns))
