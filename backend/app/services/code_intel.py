"""Code-intelligence operations shared by the REST API, the Ask pipeline and the MCP server.

Everything here is a direct graph or search lookup: no LLM calls, so results are exact,
fast and free. `CodeAgent` is the only place that adds generation on top.
"""

import os
from collections import defaultdict
from functools import lru_cache
from typing import Any, Literal

from app.core.languages import language_for_path
from app.services.embeddings import EmbeddingSettings, build_embeddings
from app.services.graph_db import graph_db
from app.services.hybrid_search import hybrid_search
from app.services.lexical_db import DEFAULT_FIELDS, LexicalDB, lexical_db
from app.services.reranker import CrossEncoderReranker

Direction = Literal["callers", "callees"]

# Why a dependent is affected, in words, for API consumers and the answer prompt.
RELATION_LABELS = {
    "CALLS": "calls",
    "INHERITS": "subclasses",
    "OVERRIDES": "overrides",
}


@lru_cache(maxsize=1)
def get_embeddings() -> Any:
    """One embedding backend per process, shared by the agent and search_code."""
    return build_embeddings(EmbeddingSettings.from_env(), api_key=os.getenv("GEMINI_API_KEY"))


@lru_cache(maxsize=1)
def get_reranker() -> CrossEncoderReranker | None:
    return CrossEncoderReranker.from_env()


def list_repositories() -> list[dict[str, Any]]:
    graph_db.connect()
    return graph_db.list_repositories()


def find_definitions(repo_url: str, name: str) -> list[dict[str, Any]]:
    """Every symbol called `name`, with its class, bases, overrides and direct calls/callers."""
    graph_db.connect()
    return graph_db.get_symbol_context(repo_url, anchors=[], names=[name], max_depth=1, anchor_limit=25, fanout=50)


def get_symbol_code(repo_url: str, name: str, filepath: str | None = None) -> list[dict[str, Any]]:
    """Full source of every symbol called `name` (classes come back as their header)."""
    graph_db.connect()
    targets = graph_db.find_symbols(repo_url, name, filepath=filepath)
    refs = [{"filepath": t["filepath"], "symbol": t["name"], "start_line": t["start_line"]} for t in targets]
    return lexical_db.get_chunks(repo_url, refs)


def code_at(repo_url: str, filepath: str, line: int) -> dict[str, Any] | None:
    """The indexed symbol containing `filepath:line`, with its code (what a citation points at)."""
    graph_db.connect()
    symbol = graph_db.symbol_at(repo_url, filepath, line)
    if symbol is None:
        return None
    ref = {"filepath": symbol["filepath"], "symbol": symbol["name"], "start_line": symbol["start_line"]}
    chunks = lexical_db.get_chunks(repo_url, [ref])
    return {**symbol, "code": chunks[0]["code_text"] if chunks else None}


def call_neighbours(
    repo_url: str,
    name: str,
    direction: Direction,
    depth: int = 1,
    filepath: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    graph_db.connect()
    return graph_db.get_call_neighbours(repo_url, name, direction, depth=depth, filepath=filepath, limit=limit)


def impact(
    repo_url: str,
    name: str,
    depth: int = 3,
    filepath: str | None = None,
    max_symbols: int = 300,
) -> dict[str, Any] | None:
    """What could break if `name` changes: everything that depends on it, up to `depth` hops.

    A symbol depends on another if it calls it, subclasses it, or (for the changed method
    itself) overrides it in a subclass. The walk goes one level at a time and records, for
    each affected symbol, the shortest distance and the symbol it reaches the change through.
    Returns None when no symbol has that name.
    """
    graph_db.connect()
    targets = graph_db.find_symbols(repo_url, name, filepath=filepath)
    if not targets:
        return None

    seen = {(t["filepath"], t["name"]) for t in targets}
    frontier = [{"filepath": t["filepath"], "name": t["name"]} for t in targets]
    for owner in _instantiated_classes(targets):
        # Calls like `Cls(...)` link to the class, not its constructor, so whoever
        # instantiates the class (or subclasses it) depends on the constructor.
        if owner not in seen:
            seen.add(owner)
            frontier.append({"filepath": owner[0], "name": owner[1]})
    affected: list[dict[str, Any]] = []
    truncated = False

    for hop in range(1, depth + 1):
        # Overrides only count for the changed symbol itself: a subclass overriding one of
        # its callers isn't affected unless it calls that caller, which CALLS already covers.
        rows = graph_db.get_direct_dependents(repo_url, frontier, with_overrides=hop == 1)
        next_frontier = []
        for row in rows:
            key = (row["filepath"], row["name"])
            if key in seen:
                continue
            if len(affected) >= max_symbols:
                truncated = True
                break
            seen.add(key)
            affected.append(
                {
                    "name": row["name"],
                    "filepath": row["filepath"],
                    "start_line": row["start_line"],
                    "end_line": row["end_line"],
                    "type": row["type"],
                    "hops": hop,
                    "relation": RELATION_LABELS.get(row["relation"], row["relation"].lower()),
                    "via": {"name": row["via_name"], "filepath": row["via_filepath"]},
                }
            )
            next_frontier.append({"filepath": row["filepath"], "name": row["name"]})
        if truncated or not next_frontier:
            break
        frontier = next_frontier

    return {
        "name": name,
        "depth": depth,
        "targets": targets,
        "total": len(affected),
        "truncated": truncated,
        "files": _group_by_file(affected),
        "affected": affected,
    }


def _instantiated_classes(targets: list[dict[str, Any]]) -> list[tuple[str, str]]:
    """(filepath, class) for every target that is its class's constructor."""
    owners = []
    for t in targets:
        lang = language_for_path(t["filepath"])
        owner, _, method = t["name"].rpartition(".")
        if t["type"] == "method" and lang is not None and owner and method in lang.constructor_names:
            owners.append((t["filepath"], owner))
    return owners


def _group_by_file(affected: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_file: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in affected:
        by_file[item["filepath"]].append(item)
    files = [
        {
            "filepath": path,
            "count": len(items),
            "nearest_hops": min(i["hops"] for i in items),
            "symbols": [i["name"] for i in sorted(items, key=lambda i: (i["hops"], i["name"]))],
        }
        for path, items in by_file.items()
    ]
    # Closest and most affected files first: where a reviewer should look.
    return sorted(files, key=lambda f: (f["nearest_hops"], -f["count"], f["filepath"]))


def search_code(repo_url: str, query: str, limit: int = 8) -> list[dict[str, Any]]:
    """Hybrid search (vectors + BM25, fused with RRF) reranked by the cross-encoder."""
    vectors = get_embeddings().embed_queries([query])
    hits = hybrid_search.search(
        query_vectors=vectors,
        lexical_terms=LexicalDB.extract_terms([query]),
        repo_url=repo_url,
        limit=max(24, limit),
        score_threshold=0.25,
        lexical_fields=DEFAULT_FIELDS,
    )
    reranker = get_reranker()
    if reranker is not None:
        hits, _ = reranker.rerank(query, hits, limit)
    return hits[:limit]
