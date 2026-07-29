import logging
from langchain_google_genai import ChatGoogleGenerativeAI
from app.core.schemas import QueryRewrite

logger = logging.getLogger(__name__)


class QueryRewriter:
    def __init__(self, llm: ChatGoogleGenerativeAI):
        self.llm = llm
        self.structured_llm = self.llm.with_structured_output(
            QueryRewrite
        )

    def rewrite(
        self,
        question: str,
        query_type: str,
        complexity: str,
        symbols: list[str],
    ) -> QueryRewrite:

        prompt = f"""
You are a query rewriting system for an AI codebase intelligence platform.

Your task is NOT to answer the question.

Your task is ONLY to produce retrieval-optimized search queries.

The rewritten queries will be used for semantic retrieval from a codebase.


Original Question:
{question}

Query Type:
{query_type}

Complexity:
{complexity}

Explicit Symbols:
{symbols}


Rules:

1. Produce between ONE and THREE search queries.

2. Keep each query concise.

3. Preserve every explicit code symbol exactly as written.

4. Prefer technical terminology likely to appear in source code.

5. Do NOT answer the question.

6. Do NOT invent function names, class names, or variables.

7. Do NOT produce conversational paraphrases.

8. If the original question is already an excellent retrieval query,
return it unchanged.


Examples

Question:
Where is process_repository defined?

Output:
[
 "process_repository definition"
]


Question:
What calls validate_token?

Output:
[
 "validate_token callers",
 "validate_token references"
]


Question:
Explain how CodeAgent uses Qdrant.

Output:
[
 "CodeAgent Qdrant interaction",
 "CodeAgent vector search",
 "CodeAgent Qdrant retrieval"
]


Question:
How is authentication implemented?

Output:
[
 "authentication implementation",
 "authentication flow",
 "user authentication"
]
"""

        try:
            result = self.structured_llm.invoke(prompt)

            logger.info(
                "Query rewrite: %s",
                result.queries,
            )

            return result

        except Exception as e:
            logger.error(
                "Query rewriting failed: %s",
                e,
                exc_info=True,
            )

            return QueryRewrite(
                queries=[question],
            )