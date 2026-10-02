import pytest

from app.services.reranker import CrossEncoderReranker


class FakeRanker:
    """Stands in for flashrank.Ranker: scores passages by a lookup on their text."""

    def __init__(self, scores, fail=False):
        self.scores = scores
        self.fail = fail
        self.requests = []

    def rerank(self, request):
        if self.fail:
            raise RuntimeError("onnx exploded")
        self.requests.append(request)
        return [
            {"id": p["id"], "score": next(v for k, v in self.scores.items() if k in p["text"])}
            for p in request.passages
        ]


def _hits():
    return [
        {"symbol": "BadSignature", "filepath": "exc.py", "chunk_type": "class", "score": 1.0, "code_text": "class BadSignature: ..."},
        {"symbol": "Signer.unsign", "filepath": "signer.py", "chunk_type": "method", "score": 0.8, "code_text": "def unsign(self): ..."},
        {"symbol": "want_bytes", "filepath": "encoding.py", "chunk_type": "function", "score": 0.6, "code_text": "def want_bytes(s): ..."},
    ]


def test_cross_encoder_reorders_and_trims_to_top_k():
    ranker = FakeRanker({"BadSignature": 0.01, "Signer.unsign": 0.97, "want_bytes": 0.40})
    reranker = CrossEncoderReranker(ranker=ranker, weight=0.75)

    results, info = reranker.rerank("What does unsign call?", _hits(), top_k=2)

    assert [r["symbol"] for r in results] == ["Signer.unsign", "want_bytes"]
    top = results[0]
    assert top["retrieval_rank"] == 2 and top["retrieval_score"] == 0.8
    assert top["rerank_score"] == 0.97
    assert top["score"] == pytest.approx(0.75 * 0.97 + 0.25 * 0.8)
    assert info["applied"] is True and info["candidates"] == 3
    assert ranker.requests[0].query == "What does unsign call?"


def test_weight_keeps_strong_retrieval_signal_when_model_is_unsure():
    # Equal cross-encoder scores: retrieval order decides.
    ranker = FakeRanker({"BadSignature": 0.5, "Signer.unsign": 0.5, "want_bytes": 0.5})
    results, _ = CrossEncoderReranker(ranker=ranker).rerank("q", _hits(), top_k=3)
    assert [r["symbol"] for r in results] == ["BadSignature", "Signer.unsign", "want_bytes"]


def test_failure_falls_back_to_retrieval_order():
    reranker = CrossEncoderReranker(ranker=FakeRanker({}, fail=True))
    results, info = reranker.rerank("q", _hits(), top_k=2)
    assert [r["symbol"] for r in results] == ["BadSignature", "Signer.unsign"]
    assert info["applied"] is False and "onnx exploded" in info["error"]


def test_passage_leads_with_symbol_and_path_and_caps_lines():
    reranker = CrossEncoderReranker(ranker=FakeRanker({}), snippet_max_lines=2)
    text = reranker.passage({"symbol": "A.b", "chunk_type": "method", "filepath": "a.py", "code_text": "1\n2\n3\n4"})
    assert text == "A.b (method) in a.py\n1\n2"


def test_disabled_by_env(monkeypatch):
    monkeypatch.setenv("RERANKER_MODEL", "none")
    assert CrossEncoderReranker.from_env() is None


def test_agent_rerank_node_trims_when_disabled():
    from app.services.agent import AgentConfig, CodeAgent

    agent = CodeAgent.__new__(CodeAgent)
    agent.config = AgentConfig(llm_model="t", embedding_model="t", api_key="t", vector_top_k=2)
    agent.reranker = None
    out = agent.node_rerank({"question": "q", "vector_results": _hits(), "errors": []})
    assert [r["symbol"] for r in out["vector_results"]] == ["BadSignature", "Signer.unsign"]
    assert out["rerank_info"]["applied"] is False


def test_agent_rerank_node_uses_reranker_and_records_info():
    from app.services.agent import AgentConfig, CodeAgent

    agent = CodeAgent.__new__(CodeAgent)
    agent.config = AgentConfig(llm_model="t", embedding_model="t", api_key="t", vector_top_k=1)
    agent.reranker = CrossEncoderReranker(ranker=FakeRanker({"BadSignature": 0.0, "Signer.unsign": 0.9, "want_bytes": 0.1}))
    out = agent.node_rerank({"question": "q", "vector_results": _hits(), "errors": []})
    assert [r["symbol"] for r in out["vector_results"]] == ["Signer.unsign"]
    assert out["rerank_info"]["applied"] is True
    assert out["errors"] == []
