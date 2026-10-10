"""The evaluation harness's own logic: dataset checks, scoring, ablation switches."""

import pytest

from eval import dataset, metrics, report, runner
from eval.dataset import Case, Gold


def case(**kw):
    defaults = {"id": "c", "kind": "behaviour", "question": "q?", "gold": (Gold("A.run", "a.py"),)}
    return Case(**{**defaults, **kw})


def test_gold_parses_with_and_without_a_path():
    assert Gold.parse("src/a.py::A.run") == Gold("A.run", "src/a.py")
    assert Gold.parse("A.run") == Gold("A.run", None)


def test_the_click_dataset_loads_and_every_answerable_case_has_gold():
    ds = dataset.load("click")
    assert ds.repo == "https://github.com/pallets/click"
    assert all(c.gold for c in ds.cases if c.answerable)
    assert any(not c.answerable for c in ds.cases)


def test_bad_cases_are_rejected(tmp_path):
    path = tmp_path / "bad.toml"
    path.write_text('repo = "r"\n[[case]]\nid = "x"\nkind = "behaviour"\nquestion = "q"\n')
    with pytest.raises(ValueError, match="needs at least one gold"):
        dataset.load(str(path))
    path.write_text('repo = "r"\n[[case]]\nid = "x"\nkind = "guess"\nquestion = "q"\ngold = ["A"]\n')
    with pytest.raises(ValueError, match="kind"):
        dataset.load(str(path))


def test_overloads_match_their_base_name_and_paths_must_agree():
    gold = Gold("Context.invoke", "core.py")
    assert metrics.matches({"symbol": "Context.invoke#3", "filepath": "core.py"}, gold)
    assert not metrics.matches({"symbol": "Context.invoke", "filepath": "other.py"}, gold)
    assert not metrics.matches({"symbol": "Context.invoke_all", "filepath": "core.py"}, gold)
    assert metrics.matches({"symbol": "Context.invoke", "filepath": "anywhere.py"}, Gold("Context.invoke"))


def test_retrieval_scores_follow_the_stages():
    c = case(gold=(Gold("A.run", "a.py"), Gold("B.go", "b.py")))
    a = {"symbol": "A.run", "filepath": "a.py", "start_line": 1, "end_line": 10}
    b = {"symbol": "B.go", "filepath": "b.py", "start_line": 5, "end_line": 6}
    noise = {"symbol": "N", "filepath": "n.py", "start_line": 1, "end_line": 1}
    s = metrics.retrieval_scores(c, {"candidates": [noise, a, b], "reranked": [noise, a], "context": [noise, a, b]})
    assert s["candidate_recall"] == 1.0
    assert s["reranked_recall"] == 0.5
    assert s["context_recall"] == 1.0 and s["all_gold_in_context"]
    assert s["first_gold_rank"] == 2 and s["reciprocal_rank"] == 0.5
    assert s["context_lines"] == 13 and s["missing"] == []


def test_mentions_accept_any_phrasing_and_ignore_case():
    c = case(mention=(("propagat", "re-raise"), ("exit code",)))
    assert metrics.mention_score(c, "Exceptions are PROPAGATED to the caller.") == 0.5
    assert metrics.mention_score(case(), "anything") is None


@pytest.mark.parametrize(
    "text",
    [
        "The provided context doesn't contain any HTTP code.",
        "Based on the provided context, there is no implementation of an HTTP download.",
        "This isn't in the shown code, so I can't confirm it.",
    ],
)
def test_abstentions_are_recognised(text):
    assert metrics.abstained(text)


@pytest.mark.parametrize(
    "text",
    [
        "Command.main creates the context and calls invoke (`core.py:1580`).",
        # Ordinary negations in an answer that does answer (seen in real answers).
        "Defaults are filled for parameters that are not already present in `kwargs`.",
        "If it does not exist (`rv is None`), it creates a new instance of `object_type`.",
        "It resolves the command.\n\n*(Note: dynamic calls that can't be resolved statically are not listed.)*",
    ],
)
def test_answers_that_answer_are_not_abstentions(text):
    assert not metrics.abstained(text)


def test_answer_scores():
    c = case()
    result = {
        "answer": "It runs.",
        "citations": [
            {"filepath": "a.py", "line": 3, "status": "verified"},
            {"filepath": "z.py", "line": 9, "status": "unknown_file"},
        ],
        "followups": [{"items": []}],
        "status": "ok",
    }
    s = metrics.answer_scores(c, result, [{"filepath": "src/a.py", "start_line": 1, "end_line": 5}])
    assert s["citation_validity"] == 0.5
    assert s["cites_gold"] is True
    assert s["asked_for_more"] is True


def test_summary_averages_numbers_and_booleans_but_not_ranks():
    out = metrics.summarize(
        [{"x": 1.0, "ok": True, "first_gold_rank": 1}, {"x": 0.0, "ok": False, "first_gold_rank": None}]
    )
    assert out == {"cases": 2, "x": 0.5, "ok": 0.5}


class FakeAgent:
    def __init__(self):
        from app.services.agent import AgentConfig

        self.config = AgentConfig(llm_model="t", embedding_model="t", api_key="t")
        self.reranker = object()
        self.query_planner = object()


@pytest.mark.parametrize("name", list(runner.VARIANTS))
def test_every_variant_is_undone_afterwards(name):
    agent = FakeAgent()
    before = (agent.reranker, agent.config, agent.query_planner)
    with runner.variant(agent, name):
        pass
    assert (agent.reranker, agent.config, agent.query_planner) == before
    assert "_lexical_plan" not in agent.__dict__ and "node_embed_queries" not in agent.__dict__


def test_variants_switch_the_right_stage():
    agent = FakeAgent()
    with runner.variant(agent, "no_rerank"):
        assert agent.reranker is None
    with runner.variant(agent, "no_graph_expansion"):
        assert agent.config.graph_expand_limit == 0
    with runner.variant(agent, "vector_only"):
        assert agent._lexical_plan({}) == ([], ())
    with pytest.raises(ValueError), runner.variant(agent, "nonsense"):
        pass


def test_recorded_plans_replay_without_a_model(tmp_path):
    path = tmp_path / "plans.json"
    path.write_text(
        '{"plans": {"q?": {"query_type": "general", "complexity": "simple", "symbols": [], "queries": ["x"]}}}'
    )
    planner = runner.RecordedPlanner(path, live=None)
    assert planner.plan("q?").queries == ["x"]
    with pytest.raises(runner.MissingPlan):
        planner.plan("unknown?")


def test_report_marks_regressions():
    assert report._cell("context_recall", 0.8, 0.9) == "80% (-10 pts ⚠)"
    assert report._cell("context_recall", 0.9, 0.8) == "90% (+10 pts)"
    assert report._cell("false_abstention", 0.1, 0.2) == "10% (-10 pts)"
    assert report._cell("seconds", 3.0, None) == "3.0"


def test_symbols_listed_without_code_count_as_shown_but_not_as_chunks():
    c = case(gold=(Gold("A.run", "a.py"),))
    listed = [{"symbol": "A.run", "filepath": "a.py", "start_line": 1}]
    s = metrics.retrieval_scores(c, {"candidates": [], "reranked": [], "context": [], "listed": listed})
    assert s["context_recall"] == 1.0 and s["context_chunks"] == 0
