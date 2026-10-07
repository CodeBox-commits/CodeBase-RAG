"""Ask-for-more: the model may request missing code once, unless the caller skips it."""

from types import SimpleNamespace

import pytest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage

from app.services import agent as agent_module
from app.services import code_intel
from app.services.agent import AgentConfig, CodeAgent

HIT = {
    "symbol": "Signer.unsign",
    "filepath": "src/signer.py",
    "start_line": 244,
    "end_line": 256,
    "code_text": "def unsign(self, value):\n    return self.verify_signature(value)",
}
REQUESTED = {
    "symbol": "Signer.verify_signature",
    "filepath": "src/signer.py",
    "start_line": 227,
    "end_line": 242,
    "code_text": "def verify_signature(self, value, sig):\n"
    + "    ...\n" * 7
    + "    for secret_key in reversed(self.secret_keys):\n"
    + "    ...\n" * 7,
}


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("NEED: Signer.verify_signature, src/timed.py", ["Signer.verify_signature", "src/timed.py"]),
        ("**NEED:** `a`; `b`\n`c`.", ["a", "b", "c"]),
        ("  NEED:a,a,b", ["a", "b"]),
        ("The newest key signs (`signer.py:176`).", None),
        ("Needless to say, it signs.", None),
    ],
)
def test_parse_request(text, expected):
    assert CodeAgent.parse_request(text, max_items=5) == expected


def test_request_items_are_capped():
    assert CodeAgent.parse_request("NEED: a, b, c, d, e, f, g", max_items=3) == ["a", "b", "c"]


class Recorder:
    """A fake chat model that records each prompt it gets."""

    def __init__(self, replies):
        self.model = GenericFakeChatModel(messages=iter([AIMessage(content=r) for r in replies]))
        self.prompts = []

    def invoke(self, messages, *args, **kwargs):
        self.prompts.append(messages)
        return self.model.invoke(messages, *args, **kwargs)


@pytest.fixture
def agent(monkeypatch):
    a = CodeAgent.__new__(CodeAgent)
    a.config = AgentConfig(llm_model="test", embedding_model="test", api_key="test")
    a.query_planner = SimpleNamespace(
        plan=lambda q, history=None: SimpleNamespace(
            query_type="implementation", complexity="simple", symbols=[], queries=[]
        )
    )
    a.embeddings = SimpleNamespace(embed_queries=lambda qs: [[0.1] * 4 for _ in qs])
    a.reranker = None
    a.fallback_llm = None
    monkeypatch.setattr(agent_module.hybrid_search, "search", lambda **kw: [HIT])
    monkeypatch.setattr(agent_module.graph_db, "connect", lambda: None)
    monkeypatch.setattr(agent_module.graph_db, "get_symbol_context", lambda **kw: [])
    monkeypatch.setattr(
        code_intel, "get_symbol_code", lambda repo, name, filepath=None: [REQUESTED] if "verify" in name else []
    )
    monkeypatch.setattr(code_intel, "search_code", lambda repo, query, limit=8: [])
    return a


def use_llm(agent, *replies):
    recorder = Recorder(replies)
    # The workflow calls self.llm.invoke inside the node; LangGraph streams its tokens.
    agent.llm = recorder.model
    agent._generate_prompts = recorder.prompts
    original = agent._generate

    def generate(system, user):
        recorder.prompts.append((system, user))
        return original(system, user)

    agent._generate = generate
    agent.workflow = agent._build_workflow()
    return recorder


def test_model_request_fetches_the_code_then_answers(agent):
    rec = use_llm(agent, "NEED: Signer.verify_signature", "Keys are tried newest first (`src/signer.py:235`).")

    events = list(agent.run_stream("Which key is tried first?", "https://github.com/a/b"))

    steps = [e["node"] for e in events if e["type"] == "step"]
    assert steps[-1] == "fetch_more"
    fetched = next(e for e in events if e.get("node") == "fetch_more")["data"]
    assert fetched["items"] == [
        {
            "item": "Signer.verify_signature",
            "found": [{k: REQUESTED[k] for k in ("symbol", "filepath", "start_line", "end_line")}],
        }
    ]
    # The request itself never reaches the UI; the real answer streams.
    streamed = "".join(e["content"] for e in events if e["type"] == "token")
    assert "NEED" not in streamed and streamed.startswith("Keys are tried newest first")
    final = events[-1]
    assert final["type"] == "answer" and [c["status"] for c in final["citations"]] == ["verified"]

    first_system, _ = rec.prompts[0]
    second_system, second_user = rec.prompts[1]
    assert "NEED:" in first_system and "NEED:" not in second_system  # one chance only
    assert "requested by the model: Signer.verify_signature" in second_user
    assert "reversed(self.secret_keys)" in second_user


def test_skip_option_answers_from_the_first_context(agent):
    rec = use_llm(agent, "Keys are tried in order.")
    result = agent.run("Which key is tried first?", "https://github.com/a/b", allow_followup=False)
    assert result["answer"] == "Keys are tried in order." and result["followups"] == []
    assert "NEED:" not in rec.prompts[0][0]


def test_a_request_without_a_round_left_becomes_a_clear_answer(agent):
    use_llm(agent, "NEED: Signer.verify_signature", "NEED: something_else")
    result = agent.run("Which key is tried first?", "https://github.com/a/b")
    assert len(result["followups"]) == 1  # fetched once, never twice
    assert result["answer"].startswith("The retrieved context wasn't enough to answer this reliably.")
    assert "`something_else`" in result["answer"]


def test_paths_and_unknown_names_fall_back_to_search(agent, monkeypatch):
    searched = []
    monkeypatch.setattr(
        code_intel, "search_code", lambda repo, query, limit=8: searched.append(query) or [{**HIT, "symbol": "timed"}]
    )
    state = {**agent._initial_state("q", "r"), "requested": ["src/timed.py", "missing_fn"], "vector_results": []}
    out = agent.node_fetch_more(state)
    assert searched == ["src/timed.py", "missing_fn"]
    assert out["followup_round"] == 1 and out["requested"] == []
    # The same hit found for two items is only added once.
    assert [h["reason"] for h in out["expanded_results"]] == ["requested by the model: src/timed.py"]
