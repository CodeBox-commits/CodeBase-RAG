"""Code-intelligence lookups straight from the graph: no LLM, no embeddings.

These are the building blocks for impact analysis and the MCP server.
"""

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query

from app.core.urls import normalize_repo_url
from app.services.graph_db import graph_db

router = APIRouter()

RepoQuery = Query(..., description="Repository URL as used for indexing")
NameQuery = Query(
    ..., min_length=1, max_length=300, description="Bare (`loads`) or qualified (`Serializer.loads`) name"
)


def _graph_call(fn, *args, **kwargs) -> Any:
    try:
        graph_db.connect()
        return fn(*args, **kwargs)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Graph database unavailable: {e}") from e


@router.get("/definitions")
async def find_definitions(repo_url: str = RepoQuery, name: str = NameQuery):
    """Every symbol with this name: location, docstring, class, bases, overrides, direct calls and callers."""
    rows = _graph_call(
        graph_db.get_symbol_context,
        normalize_repo_url(repo_url),
        anchors=[],
        names=[name],
        max_depth=1,
        anchor_limit=25,
        fanout=50,
    )
    if not rows:
        raise HTTPException(status_code=404, detail=f"No symbol named '{name}' in this repository")
    return {"name": name, "definitions": rows}


def _neighbours(direction: Literal["callers", "callees"]):
    async def endpoint(
        repo_url: str = RepoQuery,
        name: str = NameQuery,
        filepath: str | None = Query(None, description="Only the definition in this file"),
        depth: int = Query(1, ge=1, le=5, description="How many call hops to follow"),
        limit: int = Query(200, ge=1, le=1000),
    ):
        rows = _graph_call(
            graph_db.get_call_neighbours,
            normalize_repo_url(repo_url),
            name,
            direction,
            depth=depth,
            filepath=filepath,
            limit=limit,
        )
        if not rows:
            raise HTTPException(status_code=404, detail=f"No symbol named '{name}' in this repository")
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
