from typing import List, Optional, Literal,Annotated
from pydantic import BaseModel, Field, HttpUrl, ConfigDict,StringConstraints

class ExtractedChunk(BaseModel):

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str = Field(..., description="The functional name or identifier of the code block")
    type: Literal["function", "method", "class", "module"] = Field(
        default="function", 
        description="The structural type of the asset"
    )
    file_path: str = Field(..., description="The relative filesystem path inside the git repository")
    start_line: int = Field(..., ge=1, description="The 1-indexed line number where the signature begins")
    end_line: int = Field(..., ge=1, description="The 1-indexed line number where the block ends")
    docstring: Optional[str] = Field(None, description="Extracted documentation block, if any")
    source_code: str = Field(..., description="The raw textual code payload of this functional block")

    calls: List[str] = Field(
        default_factory=list, 
        description="List of direct internal function calls discovered inside this node's scope"
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


class QueryAnalysis(BaseModel):
    query_type: QueryType = Field(
        ...,
        description="The primary intent of the user's repository question."
    )

    complexity: QueryComplexity = Field(
        ...,
        description="Whether the question is simple or requires multi-step/cross-file reasoning."
    )

    symbols: List[str] = Field(
        default_factory=list,
        description="Explicit code symbols mentioned in the question, such as functions, classes, methods, or variables."
    )

SearchQuery = Annotated[
    str,
    StringConstraints(min_length=2, max_length=256)
]
class QueryRewrite(BaseModel):
    queries: List[SearchQuery] = Field(
        default_factory=list,
        min_length=1,
        max_length=3,
        description="Retrieval-oriented search queries."
    )