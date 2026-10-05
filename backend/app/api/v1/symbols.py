"""Code-intelligence lookups straight from the graph: no LLM, no embeddings.

Thin HTTP wrappers over app.services.code_intel, which the MCP server uses too.
"""

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.core.urls import normalize_repo_url
from app.services import code_intel

router = APIRouter()

RepoQuery = Query(..., description="Repository URL as used for indexing")
NameQuery = Query(
    ..., min_length=1, max_length=300, description="Bare (`loads`) or qualified (`Serializer.loads`) name"
)
FilepathQuery = Query(None, description="Only the definition in this file")


def _graph_call(fn, *args, **kwargs) -> Any:
    try:
        return fn(*args, **kwargs)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Graph database unavailable: {e}") from e


def _not_found(name: str) -> HTTPException:
    return HTTPException(status_code=404, detail=f"No symbol named '{name}' in this repository")


@router.get("/definitions")
async def find_definitions(repo_url: str = RepoQuery, name: str = NameQuery):
    """Every symbol with this name: location, docstring, class, bases, overrides, direct calls and callers."""
    rows = _graph_call(code_intel.find_definitions, normalize_repo_url(repo_url), name)
    if not rows:
        raise _not_found(name)
    return {"name": name, "definitions": rows}


def _neighbours(direction: code_intel.Direction):
    async def endpoint(
        repo_url: str = RepoQuery,
        name: str = NameQuery,
        filepath: str | None = FilepathQuery,
        depth: int = Query(1, ge=1, le=5, description="How many call hops to follow"),
        limit: int = Query(200, ge=1, le=1000),
    ):
        rows = _graph_call(
            code_intel.call_neighbours,
            normalize_repo_url(repo_url),
            name,
            direction,
            depth=depth,
            filepath=filepath,
            limit=limit,
        )
        if not rows:
            raise _not_found(name)
        return {"name": name, "direction": direction, "depth": depth, "matches": rows}

    return endpoint


router.add_api_route(
    "/callers",
    _neighbours("callers"),
    methods=["GET"],
    summary="Symbols that call this one, up to `depth` hops back",
)
router.add_api_route(
    "/callees",
    _neighbours("callees"),
    methods=["GET"],
    summary="Symbols this one calls, up to `depth` hops forward",
)


@router.get("/impact")
async def impact(
    repo_url: str = RepoQuery,
    name: str = NameQuery,
    filepath: str | None = FilepathQuery,
    depth: int = Query(3, ge=1, le=5, description="How many dependency hops to follow"),
    max_symbols: int = Query(300, ge=1, le=2000),
):
    """Blast radius: every symbol that calls, subclasses or overrides this one, directly or
    through up to `depth` hops, grouped by file (closest first)."""
    report = _graph_call(
        code_intel.impact, normalize_repo_url(repo_url), name, depth=depth, filepath=filepath, max_symbols=max_symbols
    )
    if report is None:
        raise _not_found(name)
    return report
