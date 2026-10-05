"""Impact analysis (blast radius) over a fake graph, plus its use in the Ask pipeline."""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import code_intel
from app.services.agent import AgentConfig, CodeAgent

# round_money <- apply_discount <- Cart.checkout <- cli.main
#                                  Cart.checkout <~ GiftCart.checkout (override)
# Cart <= GiftCart (subclass)
DEPENDENTS = {
    ("pricing.py", "round_money"): [("pricing.py", "apply_discount", "CALLS")],
    ("pricing.py", "apply_discount"): [("cart.py", "Cart.checkout", "CALLS"), ("pricing.py", "round_money", "CALLS")],
    ("cart.py", "Cart.checkout"): [("cli.py", "main", "CALLS"), ("cart.py", "GiftCart.checkout", "OVERRIDES")],
    ("cart.py", "Cart"): [("cart.py", "GiftCart", "INHERITS"), ("shop.py", "checkout_page", "CALLS")],
}
SYMBOLS = {
    "round_money": [("pricing.py", "round_money", "function")],
    "Cart.checkout": [("cart.py", "Cart.checkout", "method")],
    "Cart": [("cart.py", "Cart", "class")],
    "Cart.__init__": [("cart.py", "Cart.__init__", "method")],
    "Signer.constructor": [("signer.ts", "Signer.constructor", "method")],
}


class FakeGraph:
    def __init__(self):
        self.calls = []

    def connect(self):
        pass

    def find_symbols(self, repo_url, name, filepath=None, limit=10):
        return [
            {"name": q, "filepath": f, "start_line": 1, "end_line": 2, "type": t}
            for f, q, t in SYMBOLS.get(name, [])
            if filepath in (None, f)
        ]

    def get_direct_dependents(self, repo_url, frontier, with_overrides=False):
        self.calls.append(([f["name"] for f in frontier], with_overrides))
        rows = []
        for f in frontier:
            for path, name, rel in DEPENDENTS.get((f["filepath"], f["name"]), []):
                if rel == "OVERRIDES" and not with_overrides:
                    continue
                rows.append(
                    {
                        "via_filepath": f["filepath"],
                        "via_name": f["name"],
                        "name": name,
                        "filepath": path,
                        "start_line": 10,
                        "end_line": 12,
                        "type": "function",
                        "relation": rel,
                    }
                )
        return rows


@pytest.fixture
def graph(monkeypatch):
    fake = FakeGraph()
    monkeypatch.setattr(code_intel, "graph_db", fake)
    return fake


def test_impact_walks_callers_level_by_level(graph):
    report = code_intel.impact("r", "round_money", depth=5)
    assert [(a["name"], a["hops"], a["relation"], a["via"]["name"]) for a in report["affected"]] == [
        ("apply_discount", 1, "calls", "round_money"),
        ("Cart.checkout", 2, "calls", "apply_discount"),
        ("main", 3, "calls", "Cart.checkout"),
    ]
    # round_money calling back into itself through apply_discount is not counted twice.
    assert report["total"] == 3 and not report["truncated"]
    # Overrides are only followed for the changed symbol itself.
    assert [w for _, w in graph.calls] == [True, False, False, False]


def test_impact_of_a_method_includes_subclass_overrides(graph):
    report = code_intel.impact("r", "Cart.checkout", depth=1)
    assert {(a["name"], a["relation"]) for a in report["affected"]} == {
        ("main", "calls"),
        ("GiftCart.checkout", "overrides"),
    }


def test_impact_of_a_class_includes_subclasses_and_instantiations(graph):
    affected = code_intel.impact("r", "Cart")["affected"]
    assert {(a["name"], a["relation"]) for a in affected} == {("GiftCart", "subclasses"), ("checkout_page", "calls")}


def test_constructor_impact_includes_whoever_instantiates_the_class(graph):
    affected = code_intel.impact("r", "Cart.__init__")["affected"]
    assert {(a["name"], a["via"]["name"]) for a in affected} == {("GiftCart", "Cart"), ("checkout_page", "Cart")}
    # The class itself isn't listed as "affected": it's where the constructor lives.
    assert all(a["name"] != "Cart" for a in affected)
    # Same rule for JS/TS `constructor`; a .ts file with no dependents just yields nothing.
    assert code_intel.impact("r", "Signer.constructor")["total"] == 0
    assert graph.calls[-1][0] == ["Signer.constructor", "Signer"]


def test_impact_respects_depth_and_max_symbols(graph):
    assert [a["name"] for a in code_intel.impact("r", "round_money", depth=1)["affected"]] == ["apply_discount"]
    capped = code_intel.impact("r", "round_money", depth=5, max_symbols=2)
    assert capped["total"] == 2 and capped["truncated"] is True


def test_impact_groups_files_closest_first(graph):
    files = code_intel.impact("r", "round_money", depth=5)["files"]
    assert [(f["filepath"], f["count"], f["nearest_hops"]) for f in files] == [
        ("pricing.py", 1, 1),
        ("cart.py", 1, 2),
        ("cli.py", 1, 3),
    ]


def test_unknown_symbol_returns_none(graph):
    assert code_intel.impact("r", "nope") is None


def test_impact_endpoint(graph):
    client = TestClient(app)
    res = client.get("/api/v1/symbols/impact", params={"repo_url": "https://github.com/a/b.git", "name": "Cart"})
    assert res.status_code == 200 and res.json()["total"] == 2
    assert client.get("/api/v1/symbols/impact", params={"repo_url": "x", "name": "nope"}).status_code == 404
    assert client.get("/api/v1/symbols/impact", params={"repo_url": "x", "name": "Cart", "depth": 6}).status_code == 422


# --- in the Ask pipeline -------------------------------------------------------


@pytest.fixture
def bare_agent():
    agent = CodeAgent.__new__(CodeAgent)
    agent.config = AgentConfig(llm_model="test", embedding_model="test", api_key="test")
    return agent


def test_impact_questions_route_to_the_deep_graph_walk(bare_agent):
    assert bare_agent.node_retrieval_router({"query_type": "impact"}) == {"retrieval_strategy": "graph"}


def test_graph_node_runs_impact_only_for_impact_questions(bare_agent, graph, monkeypatch):
    from app.services import agent as agent_module

    monkeypatch.setattr(agent_module.graph_db, "connect", lambda: None)
    monkeypatch.setattr(agent_module.graph_db, "get_symbol_context", lambda **kw: [])
    state = {"repo_url": "r", "vector_results": [], "symbols": ["Cart"], "retrieval_strategy": "graph", "errors": []}

    out = bare_agent.node_graph_search({**state, "query_type": "impact"})
    assert [r["name"] for r in out["impact_results"]] == ["Cart"]

    out = bare_agent.node_graph_search({**state, "query_type": "dependency"})
    assert out["impact_results"] == []


def test_impact_is_formatted_for_the_prompt(graph):
    text = CodeAgent._format_impact([code_intel.impact("r", "round_money", depth=5)], per_report=2)
    assert text.splitlines() == [
        "Changing round_money [round_money (pricing.py:1)] can affect 3 symbols across 3 files (up to 5 hops)",
        "- apply_discount (pricing.py:10) calls round_money, 1 hop away",
        "- Cart.checkout (cart.py:10) calls apply_discount, 2 hops away",
        "- ... and 1 more",
    ]
