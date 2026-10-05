"""MCP server: tool contracts, errors, and one real round trip over streamable HTTP."""

import asyncio

import pytest
from fastapi.testclient import TestClient
from mcp.server.mcpserver.exceptions import ToolError
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route

from app import mcp_server
from app.mcp_server import _BearerToken, mcp
from app.services import code_intel

EXPECTED_TOOLS = {
    "list_repositories",
    "search_code",
    "find_definition",
    "get_symbol_code",
    "get_code_at",
    "find_callers",
    "find_callees",
    "impact_of",
    "ask_codebase",
}


def call(tool, /, **arguments):
    return asyncio.run(mcp.call_tool(tool, arguments))


def test_every_tool_is_listed_and_graph_tools_are_read_only():
    tools = {t.name: t for t in asyncio.run(mcp.list_tools())}
    assert set(tools) == EXPECTED_TOOLS
    for name in EXPECTED_TOOLS - {"ask_codebase"}:
        annotations = tools[name].annotations
        assert annotations.read_only_hint is True and annotations.open_world_hint is False
    assert "repo_url" in tools["impact_of"].input_schema["properties"]


def test_impact_tool_normalises_the_repo_and_clamps_depth(monkeypatch):
    seen = {}

    def fake(repo_url, name, depth, filepath):
        seen.update(repo_url=repo_url, name=name, depth=depth, filepath=filepath)
        return {"name": name, "total": 0, "affected": [], "files": []}

    monkeypatch.setattr(code_intel, "impact", fake)
    result = call("impact_of", repo_url="https://github.com/a/b.git/", name="Cart", depth=9)
    assert not result.is_error
    assert result.structured_content["name"] == "Cart"
    assert seen == {"repo_url": "https://github.com/a/b", "name": "Cart", "depth": 5, "filepath": None}


def test_unknown_symbol_is_a_readable_tool_error(monkeypatch):
    monkeypatch.setattr(code_intel, "call_neighbours", lambda *a, **kw: [])
    # Raised as ToolError so its text reaches the agent (the HTTP test sees it as isError).
    with pytest.raises(ToolError, match="No symbol named 'nope'"):
        call("find_callers", repo_url="https://github.com/a/b", name="nope")


def test_search_code_returns_trimmed_code(monkeypatch):
    long_code = "\n".join(f"line {i}" for i in range(300))
    monkeypatch.setattr(
        code_intel,
        "search_code",
        lambda repo, query, limit: [
            {"symbol": "f", "filepath": "a.py", "start_line": 1, "end_line": 300, "code_text": long_code, "score": 0.9}
        ],
    )
    [hit] = call("search_code", repo_url="https://github.com/a/b", query="f").structured_content["results"]
    assert hit["code"].count("\n") == mcp_server.MAX_CODE_LINES
    assert hit["code"].endswith("180 more lines")


def test_bearer_token_guard():
    app = Starlette(routes=[Route("/mcp", endpoint=_BearerToken(PlainTextResponse("ok"), "s3cret"))])
    client = TestClient(app)
    assert client.post("/mcp").status_code == 401
    assert client.post("/mcp", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.post("/mcp", headers={"Authorization": "Bearer s3cret"}).text == "ok"


def test_streamable_http_round_trip(monkeypatch):
    """initialize -> tools/list -> tools/call against the real FastAPI app at /mcp.

    The only test that starts the app's lifespan: the MCP session manager runs once per process.
    """
    from app.main import app
    from app.services.graph_db import graph_db
    from app.services.vector_db import vector_db

    monkeypatch.setattr(graph_db, "connect", lambda: None)
    monkeypatch.setattr(vector_db, "connect", lambda: None)
    monkeypatch.setattr(code_intel, "list_repositories", lambda: [{"url": "https://github.com/a/b", "symbols": 3}])
    monkeypatch.setattr(code_intel, "call_neighbours", lambda *a, **kw: [])
    headers = {"Accept": "application/json, text/event-stream"}

    def rpc(client, id_, method, params=None):
        res = client.post(
            "/mcp", json={"jsonrpc": "2.0", "id": id_, "method": method, "params": params or {}}, headers=headers
        )
        assert res.status_code == 200, res.text
        return res.json()

    with TestClient(app, base_url="http://localhost:8000") as client:
        init = rpc(
            client,
            1,
            "initialize",
            {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}},
        )
        assert init["result"]["serverInfo"]["name"] == "codebox"

        listed = rpc(client, 2, "tools/list")
        assert {t["name"] for t in listed["result"]["tools"]} == EXPECTED_TOOLS

        called = rpc(client, 3, "tools/call", {"name": "list_repositories", "arguments": {}})
        assert called["result"]["structuredContent"] == {
            "repositories": [{"url": "https://github.com/a/b", "symbols": 3}]
        }

        missing = rpc(
            client,
            4,
            "tools/call",
            {"name": "find_callers", "arguments": {"repo_url": "https://github.com/a/b", "name": "nope"}},
        )
        assert missing["result"]["isError"] is True
        assert "No symbol named 'nope'" in missing["result"]["content"][0]["text"]

        # DNS-rebinding protection: a foreign Host header is refused.
        foreign = client.post(
            "/mcp",
            json={"jsonrpc": "2.0", "id": 5, "method": "tools/list"},
            headers={**headers, "Host": "evil.example"},
        )
        assert foreign.status_code in (400, 403, 421)


@pytest.fixture(autouse=True)
def _no_token(monkeypatch):
    monkeypatch.delenv("MCP_TOKEN", raising=False)
