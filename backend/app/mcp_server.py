"""MCP server: the code-intelligence layer as tools for coding agents (Claude Code, Cursor, ...).

Served over streamable HTTP at /mcp on the same FastAPI app, stateless with plain JSON
responses: every tool is a single request/response, so no session state is needed and
any API worker can answer any call.

    claude mcp add --transport http codebox http://localhost:8000/mcp

Every tool except ask_codebase is a direct graph/search lookup (no LLM, no quota).
"""

import hmac
import os
from typing import Any

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from starlette.responses import JSONResponse
from starlette.routing import BaseRoute, Route
from starlette.types import ASGIApp, Receive, Scope, Send

from app.core.urls import normalize_repo_url
from app.services import code_intel

MCP_PATH = "/mcp"
# Code returned per symbol: enough to read a function, small enough for an agent's context.
MAX_CODE_LINES = 120

INSTRUCTIONS = """\
Code intelligence over indexed Git repositories (Python, JavaScript, TypeScript).
Start with list_repositories to get a repo_url. Symbols are bare (`loads`) or qualified
(`Serializer.loads`) names. Graph tools (find_definition, find_callers, find_callees,
impact_of) are exact and cheap; prefer them over search_code when you know the name.
The call graph only links calls it can resolve statically, so dynamic dispatch and
calls into external libraries are missing."""

READ_ONLY = ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False)

mcp = MCPServer(name="codebox", title="CodeBox code intelligence", version="1.0.0", instructions=INSTRUCTIONS)


def _repo(repo_url: str) -> str:
    return normalize_repo_url(repo_url)


def _not_found(name: str, repo_url: str) -> ToolError:
    # ToolError text reaches the agent; other exceptions are reported without details.
    return ToolError(f"No symbol named '{name}' in {repo_url}. Try search_code or a qualified name.")


def _trim(code: str) -> str:
    lines = code.splitlines()
    if len(lines) <= MAX_CODE_LINES:
        return code
    return "\n".join(lines[:MAX_CODE_LINES]) + f"\n# ... {len(lines) - MAX_CODE_LINES} more lines"


def _hit(hit: dict[str, Any]) -> dict[str, Any]:
    return {
        "symbol": hit.get("symbol"),
        "filepath": hit.get("filepath"),
        "start_line": hit.get("start_line"),
        "end_line": hit.get("end_line"),
        "type": hit.get("chunk_type"),
        "language": hit.get("language"),
        "score": round(float(hit["score"]), 4) if hit.get("score") is not None else None,
        "code": _trim(hit.get("code_text") or ""),
    }


@mcp.tool(annotations=READ_ONLY)
def list_repositories() -> dict[str, Any]:
    """Indexed repositories with their symbol counts, most recently indexed first."""
    return {"repositories": code_intel.list_repositories()}


@mcp.tool(annotations=READ_ONLY)
def search_code(repo_url: str, query: str, limit: int = 8) -> dict[str, Any]:
    """Find code by meaning or keywords: hybrid vector + BM25 search, reranked by a cross-encoder.

    Use this when you don't know the symbol name. Returns each hit's location and code.
    """
    hits = code_intel.search_code(_repo(repo_url), query, limit=max(1, min(limit, 20)))
    return {"query": query, "results": [_hit(h) for h in hits]}


@mcp.tool(annotations=READ_ONLY)
def find_definition(repo_url: str, name: str) -> dict[str, Any]:
    """Where a symbol is defined, with its class, base classes, subclasses, methods,
    overrides (both directions), direct calls and direct callers."""
    repo = _repo(repo_url)
    rows = code_intel.find_definitions(repo, name)
    if not rows:
        raise _not_found(name, repo)
    return {"name": name, "definitions": rows}


@mcp.tool(annotations=READ_ONLY)
def get_symbol_code(repo_url: str, name: str, filepath: str | None = None) -> dict[str, Any]:
    """Full source code of a symbol (a class comes back as its header; get methods separately)."""
    repo = _repo(repo_url)
    chunks = code_intel.get_symbol_code(repo, name, filepath=filepath)
    if not chunks:
        raise _not_found(name, repo)
    return {"name": name, "symbols": [_hit(c) for c in chunks]}


@mcp.tool(annotations=READ_ONLY)
def get_code_at(repo_url: str, filepath: str, line: int) -> dict[str, Any]:
    """The function, method or class containing `filepath:line`, with its code.

    Use it to check a file:line reference (for example a citation from ask_codebase).
    """
    repo = _repo(repo_url)
    found = code_intel.code_at(repo, filepath, line)
    if found is None:
        raise ToolError(f"No indexed symbol contains {filepath}:{line} in {repo}.")
    return {**found, "code": _trim(found.get("code") or "")}


@mcp.tool(annotations=READ_ONLY)
def find_callers(repo_url: str, name: str, depth: int = 1, filepath: str | None = None) -> dict[str, Any]:
    """Symbols that call this one, up to `depth` (1-5) hops back, nearest first."""
    repo = _repo(repo_url)
    rows = code_intel.call_neighbours(repo, name, "callers", depth=max(1, min(depth, 5)), filepath=filepath)
    if not rows:
        raise _not_found(name, repo)
    return {"name": name, "depth": depth, "matches": rows}


@mcp.tool(annotations=READ_ONLY)
def find_callees(repo_url: str, name: str, depth: int = 1, filepath: str | None = None) -> dict[str, Any]:
    """Symbols this one calls, up to `depth` (1-5) hops forward, nearest first."""
    repo = _repo(repo_url)
    rows = code_intel.call_neighbours(repo, name, "callees", depth=max(1, min(depth, 5)), filepath=filepath)
    if not rows:
        raise _not_found(name, repo)
    return {"name": name, "depth": depth, "matches": rows}


@mcp.tool(annotations=READ_ONLY)
def impact_of(repo_url: str, name: str, depth: int = 3, filepath: str | None = None) -> dict[str, Any]:
    """Blast radius of changing a symbol: everything that calls it, subclasses it or overrides
    it, directly or through up to `depth` (1-5) hops, grouped by file with the closest first.

    Use before editing a function or class to see what else needs checking or updating.
    """
    repo = _repo(repo_url)
    report = code_intel.impact(repo, name, depth=max(1, min(depth, 5)), filepath=filepath)
    if report is None:
        raise _not_found(name, repo)
    return report


@mcp.tool(annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False, open_world_hint=True))
def ask_codebase(repo_url: str, question: str) -> dict[str, Any]:
    """Answer a question about the repository with cited file:line sources.

    Runs the full RAG pipeline (plan, hybrid search, rerank, graph walk) and calls Gemini,
    so it's slower and uses quota. Prefer the graph tools for exact structural questions.
    """
    from app.services.agent import get_agent  # imported lazily: needs GEMINI_API_KEY

    try:
        agent = get_agent()
    except RuntimeError as e:
        raise ToolError(str(e)) from e
    result = agent.run(question, _repo(repo_url))
    # Citations carry a status (verified / graph / wrong_line / unknown_file): trust accordingly.
    return {"question": question, **result}


# --- HTTP wiring ---------------------------------------------------------------------


def _env_list(name: str, default: str) -> list[str]:
    return [item.strip() for item in os.getenv(name, default).split(",") if item.strip()]


def _transport_security() -> TransportSecuritySettings:
    # DNS-rebinding protection: only these Host / Origin headers are served. Production
    # sets MCP_ALLOWED_HOSTS to the public domain (see deploy/docker-compose.prod.yml).
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=_env_list("MCP_ALLOWED_HOSTS", "localhost:*,127.0.0.1:*,[::1]:*"),
        allowed_origins=_env_list("MCP_ALLOWED_ORIGINS", "http://localhost:*,http://127.0.0.1:*,http://[::1]:*"),
    )


class _BearerToken:
    """Requires `Authorization: Bearer $MCP_TOKEN` when MCP_TOKEN is set (it should be in production)."""

    def __init__(self, app: ASGIApp, token: str):
        self.app = app
        self.expected = f"Bearer {token}".encode()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            supplied = dict(scope.get("headers") or []).get(b"authorization", b"")
            if not hmac.compare_digest(supplied, self.expected):
                response = JSONResponse({"error": "missing or invalid bearer token"}, status_code=401)
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


def build_routes() -> list[BaseRoute]:
    """The MCP endpoint as routes to add to the FastAPI app (before the static UI mount)."""
    starlette_app = mcp.streamable_http_app(
        streamable_http_path=MCP_PATH,
        stateless_http=True,
        json_response=True,
        transport_security=_transport_security(),
    )
    token = os.getenv("MCP_TOKEN")
    if not token:
        return list(starlette_app.routes)
    return [
        Route(r.path, endpoint=_BearerToken(r.app, token)) if isinstance(r, Route) else r for r in starlette_app.routes
    ]
