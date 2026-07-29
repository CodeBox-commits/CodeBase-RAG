import logging
from langchain_google_genai import ChatGoogleGenerativeAI
from app.core.schemas import QueryAnalysis

logger = logging.getLogger(__name__)

class QueryAnalyzer:
    def __init__(self, llm: ChatGoogleGenerativeAI):
        self.llm = llm

        self.structured_llm = self.llm.with_structured_output(
            QueryAnalysis
        )

    def analyze(self, question: str) -> QueryAnalysis:
        """
        Analyze a user question and return structured query metadata.
        """

        prompt = f"""
You are a query analyzer for an AI codebase intelligence system.

Analyze the user's question BEFORE repository retrieval.

Classify the question into exactly ONE query type:

- symbol_lookup:
  The user wants to locate where a specific function, class,
  method, variable, or other code symbol is defined.

- implementation:
  The user wants to understand what a specific piece of code
  does or how it is implemented.

- dependency:
  The user wants to know what calls, uses, imports, depends on,
  or is depended upon by a particular symbol or component.

- call_flow:
  The user wants to understand execution flow, data flow, or
  interactions across multiple functions/components.

- architecture:
  The user wants to understand the high-level structure,
  organization, or design of the repository.

- bug_analysis:
  The user wants to investigate a bug, failure, unexpected
  behavior, or possible cause of an error.

- general:
  The repository-related question does not clearly fit any
  category above.


COMPLEXITY:

Return "simple" when the question can probably be answered using
one symbol, one code location, or a small amount of local context.

Return "complex" when answering likely requires multiple files,
multiple components, several relationships, or multi-step reasoning.


SYMBOL EXTRACTION:

Extract explicit code symbols mentioned by the user.

Examples of code symbols include:
- function names
- method names
- class names
- variable names
- module names
- service/component identifiers

Do NOT invent symbols that the user did not explicitly mention.

Do NOT treat generic programming concepts as symbols unless they
are clearly being used as a named repository component.


Examples:

Question:
"Where is process_repository defined?"

Result:
query_type = symbol_lookup
complexity = simple
symbols = ["process_repository"]


Question:
"What calls validate_token?"

Result:
query_type = dependency
complexity = simple
symbols = ["validate_token"]


Question:
"Explain how CodeAgent retrieves code from Qdrant and uses Neo4j."

Result:
query_type = call_flow
complexity = complex
symbols = ["CodeAgent", "Qdrant", "Neo4j"]


Question:
"How is this backend architected?"

Result:
query_type = architecture
complexity = complex
symbols = []


Question:
"Why could repository indexing fail?"

Result:
query_type = bug_analysis
complexity = complex
symbols = []


USER QUESTION:

{question}
"""

        try:
            result = self.structured_llm.invoke(prompt)

            logger.info(
                "Query analysis: type=%s complexity=%s symbols=%s",
                result.query_type,
                result.complexity,
                result.symbols,
            )

            return result

        except Exception as e:
            logger.error(
                "Query analysis failed: %s",
                e,
                exc_info=True,
            )

            return QueryAnalysis(
                query_type="general",
                complexity="simple",
                symbols=[],
            )