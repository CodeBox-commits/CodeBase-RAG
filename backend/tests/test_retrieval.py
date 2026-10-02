import pytest

from app.core.urls import normalize_repo_url
from app.services import agent as agent_module
from app.services.agent import AgentConfig, CodeAgent
from app.services.hybrid_search import HybridSearch
from app.services.lexical_db import LexicalDB


def _hit(symbol, score, filepath="a.py", start_line=1):
    return {"symbol": symbol, "filepath": filepath, "start_line": start_line, "score": score}


# --- RRF fusion -------------------------------------------------------------

def test_fusion_scores_are_unified_and_normalised():
    fused = HybridSearch(rrf_k=60).fuse([
        ("vector", [_hit("a", 0.91), _hit("b", 0.80)]),
        ("vector", [_hit("a", 0.88)]),
        ("bm25", [_hit("a", 12.0), _hit("c", 7.5)]),
    ])

    top = fused[0]
    assert top["symbol"] == "a"
    assert top["score"] == pytest.approx(1.0)          # ranked first in every list
    assert top["sources"] == ["vector", "bm25"]
    assert top["vector_score"] == pytest.approx(0.91)  # best of the two vector lists
    assert top["bm25_score"] == pytest.approx(12.0)
    assert all(0 < r["score"] <= 1 for r in fused)
    assert all("score" in r and "sources" in r for r in fused)


def test_fusion_handles_no_lists():
    assert HybridSearch().fuse([]) == []


# --- BM25 query construction ------------------------------------------------

def test_extract_terms_drops_stopwords_and_keeps_identifiers():
    terms = LexicalDB.extract_terms(["Where is process_repository defined?", "CodeAgent.run"])
    assert terms == ["process_repository", "defined", "codeagent", "run"]


def test_build_query_ors_terms_across_fields_and_escapes_repo_tag():
    query = LexicalDB.build_query(["parse", "ast_node"], "https://github.com/a-b/c.d")
    assert query == (
        r"@repo_url:{https\:\/\/github\.com\/a\-b\/c\.d} "
        "@symbol|filepath|code_text:(parse|ast_node)"
    )


def test_exact_symbol_matches_lead_but_bm25_order_is_otherwise_kept():
    hits = [
        {"symbol": "TimestampSigner.unsign", "score": 9.0},
        {"symbol": "Other.helper", "score": 8.0},
        {"symbol": "TimestampSigner", "score": 3.0},
        {"symbol": "pkg.unsign", "score": 2.0},
    ]
    ranked = LexicalDB.rank_exact_symbols_first(hits, ["timestampsigner"])
    assert [h["symbol"] for h in ranked] == [
        "TimestampSigner", "TimestampSigner.unsign", "Other.helper", "pkg.unsign",
    ]


def test_build_query_rejects_unsafe_or_empty_terms():
    assert LexicalDB.build_query([], "https://x/y") is None
    assert LexicalDB.build_query(["a)|(b"], "https://x/y") is None


# --- URL normalisation ------------------------------------------------------

@pytest.mark.parametrize("raw", [
    "https://github.com/a/b",
    "https://github.com/a/b/",
    "https://github.com/a/b.git",
    " https://github.com/a/b.git/ ",
])
def test_repo_urls_normalise_to_one_key(raw):
    assert normalize_repo_url(raw) == "https://github.com/a/b"


# --- agent retrieval node ---------------------------------------------------

@pytest.fixture
def bare_agent():
    # Skip __init__: no LLM clients needed to exercise the retrieval nodes.
    agent = CodeAgent.__new__(CodeAgent)
    agent.config = AgentConfig(llm_model="test", embedding_model="test", api_key="test")
    return agent


def _state(**overrides):
    state = {
        "question": "How does ingestion work?",
        "repo_url": "https://github.com/a/b",
        "rewritten_queries": ["repository ingestion pipeline", "How does ingestion work?"],
        "symbols": [],
        "query_embeddings": [[0.1], [0.2]],
        "retrieval_strategy": "hybrid",
        "errors": [],
    }
    state.update(overrides)
    return state


def test_search_queries_merge_question_and_rewrites_without_duplicates(bare_agent):
    assert bare_agent._search_queries(_state()) == [
        "How does ingestion work?",
        "repository ingestion pipeline",
    ]


def test_hybrid_retrieval_uses_every_embedding_and_rewritten_terms(bare_agent, monkeypatch):
    calls = {}
    monkeypatch.setattr(agent_module.hybrid_search, "search", lambda **kw: calls.update(kw) or [])

    bare_agent.node_retrieve(_state(symbols=["process_repository"]))

    assert calls["query_vectors"] == [[0.1], [0.2]]
    assert calls["lexical_terms"][0] == "process_repository"
    assert {"ingestion", "repository", "pipeline"} <= set(calls["lexical_terms"])
    assert calls["lexical_fields"] == ("symbol", "filepath", "code_text")


def test_vector_strategy_only_adds_symbol_lookup_when_symbols_named(bare_agent, monkeypatch):
    calls = {}
    monkeypatch.setattr(agent_module.hybrid_search, "search", lambda **kw: calls.update(kw) or [])

    bare_agent.node_retrieve(_state(retrieval_strategy="vector"))
    assert calls["lexical_terms"] == []

    bare_agent.node_retrieve(_state(retrieval_strategy="vector", symbols=["CodeAgent"]))
    assert calls["lexical_terms"] == ["codeagent"]
    assert calls["lexical_fields"] == ("symbol",)


def test_graph_search_anchors_on_hits_and_question_symbols(bare_agent, monkeypatch):
    captured = {}

    def fake_context(**kw):
        captured.update(kw)
        return [{"name": "Base.save"}]

    monkeypatch.setattr(agent_module.graph_db, "connect", lambda: None)
    monkeypatch.setattr(agent_module.graph_db, "get_symbol_context", fake_context)

    out = bare_agent.node_graph_search(_state(
        symbols=["save"],
        vector_results=[{"filepath": "m.py", "symbol": "Base.save"}, {"filepath": None, "symbol": "x"}],
    ))

    assert out["graph_results"] == [{"name": "Base.save"}]
    assert captured["anchors"] == [{"filepath": "m.py", "symbol": "Base.save"}]
    assert captured["names"] == ["save"]
    assert captured["max_depth"] == 3


def test_graph_context_formatting_includes_multi_hop_neighbours():
    text = CodeAgent._format_graph_context([{
        "node_labels": ["Symbol", "Function", "Method"],
        "name": "User.rename", "filepath": "m.py", "start_line": 10, "end_line": 14,
        "owner": "User", "docstring": None, "bases": [], "subclasses": [], "methods": [],
        "calls": [{"name": "Base.save", "filepath": "m.py", "line": 3, "hops": 1},
                  {"name": "Base.validate", "filepath": "m.py", "line": 6, "hops": 2}],
        "called_by": [],
    }])
    assert text.startswith("Method 'User.rename' defined in m.py (Lines 10-14)")
    assert "Member of class: User" in text
    assert "Base.save (m.py:3)" in text
    assert "Base.validate (m.py:6, 2 hops)" in text


# --- cost optimisations -----------------------------------------------------

def test_planner_node_maps_one_plan_onto_state(bare_agent):
    from app.core.schemas import QueryPlan

    class FakePlanner:
        def plan(self, question):
            return QueryPlan(query_type="dependency", complexity="simple",
                             symbols=["validate_token"], queries=["validate_token callers"])

    bare_agent.query_planner = FakePlanner()
    out = bare_agent.node_query_planner(_state())

    assert out["query_type"] == "dependency"
    assert out["symbols"] == ["validate_token"]
    assert out["rewritten_queries"] == ["validate_token callers"]
    assert out["errors"] == []


def test_planner_failure_falls_back_and_is_reported(bare_agent):
    class BrokenPlanner:
        def plan(self, question):
            raise RuntimeError("429 RESOURCE_EXHAUSTED")

    bare_agent.query_planner = BrokenPlanner()
    out = bare_agent.node_query_planner(_state())

    assert out["query_type"] == "general"
    assert out["rewritten_queries"] == []
    assert out["errors"][0].startswith("query_planning_failed")


def test_query_embeddings_are_one_batched_call_capped_at_three(bare_agent):
    requests = []

    class FakeEmbeddings:
        def embed_queries(self, texts):
            requests.append(texts)
            return [[0.1]] * len(texts)

    bare_agent.embeddings = FakeEmbeddings()
    out = bare_agent.node_embed_queries(_state(rewritten_queries=["q1", "q2", "q3"]))

    assert requests == [["How does ingestion work?", "q1", "q2"]]
    assert len(out["query_embeddings"]) == 3


def _snippet(symbol, start, end, lines, chunk_type="function", filepath="m.py"):
    code = "\n".join(f"line {i}" for i in range(lines))
    return {"symbol": symbol, "filepath": filepath, "start_line": start, "end_line": end,
            "chunk_type": chunk_type, "code_text": code, "score": 0.5, "sources": ["vector"]}


def test_long_snippets_are_truncated_to_the_line_cap():
    text = CodeAgent._format_code_snippets([_snippet("big", 1, 100, 100)], max_lines=60)

    assert "line 59" in text and "line 60" not in text
    assert "# ... 40 more lines not shown" in text


def test_nested_hits_already_shown_in_full_are_dropped():
    outer = _snippet("outer", 10, 30, 21)
    inner = _snippet("outer.inner", 12, 15, 4)
    kept = CodeAgent._drop_nested_hits([outer, inner], max_lines=60)
    assert [h["symbol"] for h in kept] == ["outer"]

    # A truncated outer might cut the inner function off, so both stay.
    assert len(CodeAgent._drop_nested_hits([outer, inner], max_lines=10)) == 2


def test_methods_are_not_dropped_for_their_class_header():
    cls = _snippet("User", 1, 50, 3, chunk_type="class")
    method = _snippet("User.save", 10, 20, 11, chunk_type="method")
    other_file = _snippet("helper", 12, 14, 3, filepath="other.py")

    kept = CodeAgent._drop_nested_hits([cls, method, other_file], max_lines=60)
    assert len(kept) == 3


def test_graph_payload_flattens_context_into_typed_edges():
    payload = CodeAgent._graph_payload([{
        "node_labels": ["Symbol", "Function", "Method"], "name": "User.rename", "filepath": "m.py",
        "owner": "User", "bases": [], "subclasses": [], "methods": [],
        "calls": [{"name": "Base.save", "filepath": "m.py", "line": 3, "hops": 1}],
        "called_by": [{"name": "cli.main", "filepath": "cli.py", "line": 9, "hops": 2}],
    }])
    ids = {n["id"]: n for n in payload["nodes"]}
    assert ids["User.rename"]["anchor"] is True and ids["User.rename"]["kind"] == "method"
    assert {(e["source"], e["target"], e["type"]) for e in payload["edges"]} == {
        ("User.rename", "Base.save", "CALLS"),
        ("cli.main", "User.rename", "CALLS"),
        ("User", "User.rename", "HAS_METHOD"),
    }


def test_run_stream_emits_one_event_per_step_then_the_answer(bare_agent, monkeypatch):
    from types import SimpleNamespace

    bare_agent.query_planner = SimpleNamespace(plan=lambda q: SimpleNamespace(
        query_type="dependency", complexity="simple", symbols=["save"], queries=["save callers"],
    ))
    bare_agent.embeddings = SimpleNamespace(embed_queries=lambda qs: [[0.1] * 768 for _ in qs])
    bare_agent._invoke_llm_with_retry = lambda system, user: "final answer"
    monkeypatch.setattr(agent_module.hybrid_search, "search", lambda **kw: [
        {"symbol": "Base.save", "filepath": "m.py", "start_line": 3, "end_line": 5,
         "score": 1.0, "sources": ["vector", "bm25"], "code_text": "def save(self): ..."},
    ])
    monkeypatch.setattr(agent_module.graph_db, "connect", lambda: None)
    monkeypatch.setattr(agent_module.graph_db, "get_symbol_context", lambda **kw: [])
    bare_agent.workflow = bare_agent._build_workflow()

    events = list(bare_agent.run_stream("What calls save?", "https://github.com/a/b"))

    assert [e.get("node") for e in events[:-1]] == [
        "query_planner", "retrieval_router", "embed_queries", "retrieve", "rerank", "graph_search",
    ]
    assert events[1]["data"] == {"strategy": "hybrid"}
    assert events[2]["data"]["dimensions"] == 768 and len(events[2]["data"]["previews"][0]) == 24
    retrieved = events[3]["data"]
    assert retrieved["results"][0]["symbol"] == "Base.save"
    assert "code_text" not in retrieved["results"][0]
    assert "save" in retrieved["lexical_terms"]
    assert events[-1] == {"type": "token", "content": "final answer"}
