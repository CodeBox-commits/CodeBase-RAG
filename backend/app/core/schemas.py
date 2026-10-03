from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl


class ExtractedChunk(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str = Field(..., description="The functional name or identifier of the code block")
    qualified_name: str = Field(
        ..., description="Dotted scope path unique within the file, e.g. 'MyClass.method' or 'outer.inner'"
    )
    type: Literal["function", "method", "class", "module"] = Field(
        default="function", description="The structural type of the asset"
    )
    file_path: str = Field(..., description="The relative filesystem path inside the git repository")
    language: str = Field(default="python", description="Name of the Language that parsed this chunk")
    start_line: int = Field(..., ge=1, description="The 1-indexed line number where the signature begins")
    end_line: int = Field(..., ge=1, description="The 1-indexed line number where the block ends")
    docstring: str | None = Field(None, description="Extracted documentation block, if any")
    source_code: str = Field(..., description="The raw textual code payload of this functional block")

    calls: list[str] = Field(
        default_factory=list, description="List of direct internal function calls discovered inside this node's scope"
    )
    bases: list[str] = Field(
        default_factory=list, description="Base class references for class chunks, as written in the source"
    )


class RepositoryIndexPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    github_url: HttpUrl = Field(..., description="The public HTTPS URL used to clone the target repository")
    branch: str = Field(default="main", description="The specific git branch version tag to clone and index")


QueryType = Literal[
    "symbol_lookup",
    "implementation",
    "dependency",
    "call_flow",
    "architecture",
    "bug_analysis",
    "general",
]

QueryComplexity = Literal[
    "simple",
    "complex",
]


class QueryPlan(BaseModel):
    """Query analysis and retrieval rewrites, produced by a single LLM call."""

    query_type: QueryType = Field(..., description="The primary intent of the user's repository question.")

    complexity: QueryComplexity = Field(
        ..., description="Whether the question is simple or requires multi-step/cross-file reasoning."
    )

    symbols: list[str] = Field(
        default_factory=list,
        description="Explicit code symbols mentioned in the question, such as functions, classes, methods, or variables.",
    )

    # No length constraints: a slightly off-spec list must not invalidate the whole plan.
    # The agent de-duplicates and caps the queries it actually searches with.
    queries: list[str] = Field(default_factory=list, description="One or two short retrieval-oriented search queries.")


RetrievalStrategy = Literal[
    "vector",
    "graph",
    "hybrid",
]
