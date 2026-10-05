"""Citation checking, answer fallbacks, follow-up context and token streaming."""

from types import SimpleNamespace

import pytest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage

from app.services import agent as agent_module
from app.services.agent import AgentConfig, CodeAgent
from app.services.citations import Span, check_citations, graph_spans, snippet_spans, summarize
from app.services.query_planner import format_history

SNIPPETS = [
    # 30-line function, fully shown
    {"filepath": "src/pkg/signer.py", "start_line": 200, "end_line": 229, "code_text": "\n".join(["x"] * 30)},
    # 100-line function, cut to 60 lines in the prompt
    {"filepath": "src/pkg/serializer.py", "start_line": 300, "end_line": 399, "code_text": "\n".join(["x"] * 100)},
]
GRAPH = [
    {
        "filepath": "src/pkg/timed.py",
        "start_line": 50,
        "end_line": 80,
        "calls": [{"filepath": "src/pkg/encoding.py", "line": 12}],
    }
]


def spans():
    return [*snippet_spans(SNIPPETS, max_lines=60), *graph_spans(GRAPH, [])]


def test_snippet_spans_follow_what_the_prompt_shows():
    assert snippet_spans(SNIPPETS, max_lines=60) == [
        Span("src/pkg/signer.py", 200, 229, shown=True),
        Span("src/pkg/serializer.py", 300, 359, shown=True),  # lines 360+ were never shown
    ]


def test_each_citation_gets_a_status():
    answer = (
        "Signs with the newest key (`src/pkg/signer.py:210`), shortened path `serializer.py:305-307`, "
        "past the cut-off `src/pkg/serializer.py:380`, from the graph `src/pkg/timed.py:60` and "
        "`encoding.py:12`, invented `src/pkg/other.py:5`, repeated `src/pkg/signer.py:210`."
    )
    results = check_citations(answer, spans())
    assert [(c["text"], c["filepath"], c["status"]) for c in results] == [
        ("src/pkg/signer.py:210", "src/pkg/signer.py", "verified"),
        ("serializer.py:305-307", "src/pkg/serializer.py", "verified"),
        ("src/pkg/serializer.py:380", "src/pkg/serializer.py", "wrong_line"),
        ("src/pkg/timed.py:60", "src/pkg/timed.py", "graph"),
        ("encoding.py:12", "src/pkg/encoding.py", "graph"),
        ("src/pkg/other.py:5", "src/pkg/other.py", "unknown_file"),
    ]
    assert results[1]["line"] == 305 and results[1]["end_line"] == 307
    assert summarize(results) == {"total": 6, "verified": 2, "graph": 2, "wrong_line": 1, "unknown_file": 1}


def test_citation_pattern_handles_every_indexed_language_and_en_dashes():
    span = [Span("web/App.tsx", 1, 50, shown=True), Span("lib/x.mjs", 1, 9, shown=True)]
    results = check_citations("See App.tsx:10\u201312 and lib/x.mjs:3; not a.pyc:3 or http://h:80", span)
    assert [(c["text"], c["status"]) for c in results] == [
        ("App.tsx:10\u201312", "verified"),
        ("lib/x.mjs:3", "verified"),
    ]


# --- generation: fallback model, no-model answer --------------------------------


@pytest.fixture
def bare_agent():
    agent = CodeAgent.__new__(CodeAgent)
    agent.config = AgentConfig(llm_model="test", embedding_model="test", api_key="test")
    return agent


class FailingLLM:
    def __init__(self, message):
        self.message = message

    def invoke(self, messages):
        raise RuntimeError(self.message)


def test_fallback_model_is_used_only_for_capacity_errors(bare_agent):
    bare_agent.llm = FailingLLM("429 RESOURCE_EXHAUSTED")
    bare_agent.fallback_llm = SimpleNamespace(invoke=lambda m: SimpleNamespace(text="from fallback"))
    assert bare_agent._generate("s", "u") == ("from fallback", "fallback_model", "")

    bare_agent.llm = FailingLLM("400 INVALID_ARGUMENT")
    answer, status, reason = bare_agent._generate("s", "u")
    assert (answer, status, reason) == (None, "degraded", "the language model returned an error")


def test_no_model_answer_lists_retrieved_code_with_verified_citations(bare_agent, monkeypatch):
    bare_agent.llm = FailingLLM("503 UNAVAILABLE")
    bare_agent.fallback_llm = None
    state = {
        "question": "Which key signs?",
        "vector_results": [{**SNIPPETS[0], "symbol": "Signer.sign"}],
        "expanded_results": [],
        "graph_results": [],
        "impact_results": [],
        "errors": [],
        "history": [],
    }
    out = bare_agent.node_generate_response(state)
    assert out["answer_status"] == "degraded"
    assert out["answer"].startswith("**I couldn't generate an answer because the model is temporarily overloaded.**")
    assert "`src/pkg/signer.py:200` Signer.sign" in out["answer"]
    assert [c["status"] for c in out["citations"]] == ["verified"]


# --- follow-up questions -------------------------------------------------------------


HISTORY = [
    {"role": "user", "content": "What does Signer.sign do?"},
    {"role": "assistant", "content": "It signs a value. " + "detail " * 400},
]


def test_planner_sees_trimmed_history():
    text = format_history(HISTORY)
    assert "User: What does Signer.sign do?" in text
    assert "Assistant: It signs a value." in text and text.count("detail") < 100
    assert format_history([]) == ""


def test_answer_prompt_includes_the_conversation(bare_agent):
    seen = {}

    def fake_generate(system, user):
        seen["user"] = user
        return "ok", "ok", ""

    bare_agent._generate = fake_generate
    state = {
        "question": "And what calls it?",
        "vector_results": [],
        "expanded_results": [],
        "graph_results": [],
        "impact_results": [],
        "errors": [],
        "history": HISTORY,
    }
    bare_agent.node_generate_response(state)
    assert seen["user"].startswith("--- Conversation So Far ---\nUser: What does Signer.sign do?")
    assert seen["user"].index("User Question: And what calls it?") > seen["user"].index("Assistant: It signs")


def test_history_is_capped_to_the_most_recent_messages(bare_agent):
    many = [{"role": "user", "content": str(i)} for i in range(20)]
    assert [t["content"] for t in bare_agent._initial_state("q", "r", many)["history"]] == [
        str(i) for i in range(14, 20)
    ]


# --- token streaming --------------------------------------------------------------------


def test_answer_tokens_stream_before_the_final_answer_event(bare_agent, monkeypatch):
    bare_agent.query_planner = SimpleNamespace(
        plan=lambda q, history=None: SimpleNamespace(query_type="general", complexity="simple", symbols=[], queries=[])
    )
    bare_agent.embeddings = SimpleNamespace(embed_queries=lambda qs: [[0.1] * 4 for _ in qs])
    bare_agent.reranker = None
    bare_agent.fallback_llm = None
    bare_agent.llm = GenericFakeChatModel(messages=iter([AIMessage(content="Signs with `src/pkg/signer.py:210` here")]))
    monkeypatch.setattr(agent_module.hybrid_search, "search", lambda **kw: [{**SNIPPETS[0], "symbol": "Signer.sign"}])
    monkeypatch.setattr(agent_module.graph_db, "connect", lambda: None)
    monkeypatch.setattr(agent_module.graph_db, "get_symbol_context", lambda **kw: [])
    bare_agent.workflow = bare_agent._build_workflow()

    events = list(bare_agent.run_stream("Which key signs?", "https://github.com/a/b"))

    tokens = [e["content"] for e in events if e["type"] == "token"]
    assert len(tokens) > 1 and "".join(tokens) == "Signs with `src/pkg/signer.py:210` here"
    final = events[-1]
    assert final["type"] == "answer" and final["content"] == "".join(tokens) and final["status"] == "ok"
    assert [c["status"] for c in final["citations"]] == ["verified"]
    # Tokens arrive after the graph step and before the final event.
    order = [e.get("node") or e["type"] for e in events]
    assert order.index("graph_search") < order.index("token") < order.index("answer")
