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
