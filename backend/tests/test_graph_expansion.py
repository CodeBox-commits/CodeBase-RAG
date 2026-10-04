"""Graph-driven context expansion and the code-intelligence endpoints (no databases)."""

import pytest
from fastapi.testclient import TestClient

from app.api.v1 import symbols as symbols_module
from app.main import app
from app.services import agent as agent_module
from app.services.agent import AgentConfig, CodeAgent


@pytest.fixture
def bare_agent():
    agent = CodeAgent.__new__(CodeAgent)
    agent.config = AgentConfig(llm_model="test", embedding_model="test", api_key="test")
    return agent


# The itsdangerous miss: search returned the base Serializer.loads, the answer depended
# on TimedSerializer.loads, which overrides it in another file.
HITS = [
    {"filepath": "serializer.py", "symbol": "Serializer.loads", "start_line": 40},
    {"filepath": "serializer.py", "symbol": "Serializer.dumps", "start_line": 20},
]
ROWS = [
    {
        "name": "Serializer.loads",
        "filepath": "serializer.py",
        "start_line": 40,
        "calls": [
            {"name": "Signer.unsign", "filepath": "signer.py", "line": 70, "hops": 1},
            {"name": "Signer.verify_signature", "filepath": "signer.py", "line": 50, "hops": 2},
            {"name": "Serializer.dumps", "filepath": "serializer.py", "line": 20, "hops": 1},
        ],
        "overridden_by": [{"name": "TimedSerializer.loads", "filepath": "timed.py", "line": 90}],
        "overrides": [],
    },
    {"name": "TimestampSigner", "filepath": "timed.py", "start_line": 10, "calls": []},
]


def test_expansion_order_named_then_overrides_then_direct_callees():
    refs = CodeAgent.expansion_refs(HITS, ROWS, names=["TimestampSigner"], limit=10)
    assert [(r["symbol"], r["reason"]) for r in refs] == [
        ("TimestampSigner", "named in the question"),
        ("TimedSerializer.loads", "overrides Serializer.loads"),
        ("Signer.unsign", "called by Serializer.loads"),
    ]
    # 2-hop callees and symbols already retrieved are never added
    assert all(r["symbol"] not in {"Signer.verify_signature", "Serializer.dumps"} for r in refs)
    assert refs[1] == {
        "filepath": "timed.py",
        "symbol": "TimedSerializer.loads",
        "start_line": 90,
        "reason": "overrides Serializer.loads",
    }


def test_expansion_respects_the_limit_and_bare_name_matching():
    refs = CodeAgent.expansion_refs(HITS, ROWS, names=["timestampsigner"], limit=1)
    assert [r["symbol"] for r in refs] == ["TimestampSigner"]


def test_callees_only_come_from_the_top_three_hits():
    hits = [{"filepath": f"f{i}.py", "symbol": f"s{i}"} for i in range(3)] + HITS
    refs = CodeAgent.expansion_refs(hits, ROWS, names=[], limit=10)
    assert [r["symbol"] for r in refs] == ["TimedSerializer.loads"]


def test_graph_node_fetches_code_for_related_symbols(bare_agent, monkeypatch):
    seen = {}
    monkeypatch.setattr(agent_module.graph_db, "connect", lambda: None)
    monkeypatch.setattr(
        agent_module.graph_db, "get_symbol_context", lambda **kw: seen.update(depth=kw["max_depth"]) or ROWS
    )

    def fake_chunks(repo_url, refs):
        seen["refs"] = refs
        return [{"filepath": "timed.py", "symbol": "TimedSerializer.loads", "start_line": 90, "code_text": "..."}]

    monkeypatch.setattr(agent_module.lexical_db, "get_chunks", fake_chunks)

    out = bare_agent.node_graph_search(
        {"repo_url": "r", "vector_results": HITS, "symbols": [], "retrieval_strategy": "vector", "errors": []}
    )

    assert seen["depth"] == 1  # "vector" questions walk one hop
    assert [r["symbol"] for r in seen["refs"]] == ["TimedSerializer.loads", "Signer.unsign"]
    assert out["expanded_results"] == [
        {
            "filepath": "timed.py",
            "symbol": "TimedSerializer.loads",
            "start_line": 90,
            "code_text": "...",
            "sources": ["graph"],
            "reason": "overrides Serializer.loads",
        }
    ]


def test_expansion_failure_is_reported_not_raised(bare_agent, monkeypatch):
    monkeypatch.setattr(agent_module.graph_db, "connect", lambda: None)
    monkeypatch.setattr(agent_module.graph_db, "get_symbol_context", lambda **kw: ROWS)

    def boom(*a):
        raise ConnectionError("redis down")

    monkeypatch.setattr(agent_module.lexical_db, "get_chunks", boom)
    out = bare_agent.node_graph_search(
        {"repo_url": "r", "vector_results": HITS, "symbols": [], "retrieval_strategy": "hybrid", "errors": []}
    )
    assert out["graph_results"] == ROWS
    assert out["expanded_results"] == []
    assert any(e.startswith("graph_expansion_failed") for e in out["errors"])


def test_related_code_is_labelled_with_its_reason():
    text = CodeAgent._format_code_snippets(
        [
            {
                "filepath": "timed.py",
                "symbol": "TimedSerializer.loads",
                "start_line": 90,
                "end_line": 99,
                "code_text": "def loads(self): ...",
                "reason": "overrides Serializer.loads",
            }
        ]
    )
    assert "Why included: overrides Serializer.loads" in text
    assert "Relevance Score" not in text


def test_overrides_appear_in_graph_context_and_payload():
    row = {
        "node_labels": ["Symbol", "Function", "Method"],
        "name": "Serializer.loads",
        "filepath": "serializer.py",
        "start_line": 40,
        "end_line": 60,
        "overridden_by": [{"name": "TimedSerializer.loads", "filepath": "timed.py", "line": 90}],
    }
    assert "Overridden by: TimedSerializer.loads (timed.py:90)" in CodeAgent._format_graph_context([row])
    edges = CodeAgent._graph_payload([row])["edges"]
    assert {"source": "TimedSerializer.loads", "target": "Serializer.loads", "type": "OVERRIDES", "hops": 1} in edges


def test_graph_step_runs_for_every_strategy(bare_agent):
    bare_agent.workflow = bare_agent._build_workflow()
    edges = {(e.source, e.target) for e in bare_agent.workflow.get_graph().edges}
    assert ("rerank", "graph_search") in edges
    assert ("rerank", "generate_response") not in edges


# --- /api/v1/symbols ----------------------------------------------------------


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(symbols_module.graph_db, "connect", lambda: None)
    return TestClient(app)


def test_callers_endpoint_passes_direction_depth_and_normalised_url(client, monkeypatch):
    seen = {}

    def fake(repo_url, name, direction, **kw):
        seen.update(repo_url=repo_url, name=name, direction=direction, **kw)
        return [{"name": name, "symbols": [], "total": 0}]

    monkeypatch.setattr(symbols_module.graph_db, "get_call_neighbours", fake)
    res = client.get(
        "/api/v1/symbols/callers",
        params={"repo_url": "https://github.com/a/b.git", "name": "Cart.checkout", "depth": 3},
    )
    assert res.status_code == 200
    assert res.json()["direction"] == "callers"
    assert seen == {
        "repo_url": "https://github.com/a/b",
        "name": "Cart.checkout",
        "direction": "callers",
        "depth": 3,
        "filepath": None,
        "limit": 200,
    }


def test_symbol_endpoints_404_on_unknown_and_validate_depth(client, monkeypatch):
    monkeypatch.setattr(symbols_module.graph_db, "get_call_neighbours", lambda *a, **kw: [])
    monkeypatch.setattr(symbols_module.graph_db, "get_symbol_context", lambda *a, **kw: [])
    params = {"repo_url": "https://github.com/a/b", "name": "nope"}
    assert client.get("/api/v1/symbols/callees", params=params).status_code == 404
    assert client.get("/api/v1/symbols/definitions", params=params).status_code == 404
    assert client.get("/api/v1/symbols/callees", params={**params, "depth": 9}).status_code == 422


def test_symbol_endpoints_503_when_graph_is_down(client, monkeypatch):
    def down(*a, **kw):
        raise ConnectionError("neo4j down")

    monkeypatch.setattr(symbols_module.graph_db, "get_symbol_context", down)
    res = client.get("/api/v1/symbols/definitions", params={"repo_url": "https://github.com/a/b", "name": "x"})
    assert res.status_code == 503
