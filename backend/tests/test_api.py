import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api.v1 import repo as repo_module
from app.main import app
from app.services.agent import get_agent


class FakeAgent:
    def __init__(self):
        self.calls = []

    def run(self, question, repo_url, history=None, allow_followup=True):
        self.calls.append((question, repo_url, history))
        self.allow_followup = allow_followup
        return {"answer": f"answer for {repo_url}", "citations": [], "status": "ok", "followups": []}

    def run_stream(self, question, repo_url, history=None, allow_followup=True):
        yield {"type": "step", "node": "query_planner", "data": {"query_type": "general"}}
        yield {"type": "answer", "content": self.run(question, repo_url, history, allow_followup)["answer"]}


@pytest.fixture
def client():
    # No `with`: skips the lifespan, so no database connections are attempted.
    return TestClient(app)


@pytest.fixture
def fake_agent():
    agent = FakeAgent()
    app.dependency_overrides[get_agent] = lambda: agent
    yield agent
    app.dependency_overrides.clear()


def test_chat_normalises_repo_url_before_querying(client, fake_agent):
    res = client.post(
        "/api/v1/chat/",
        json={
            "question": "What does main do?",
            "repo_url": "https://github.com/a/b.git",
            "stream": False,
        },
    )

    assert res.status_code == 200
    assert res.json()["repo_url"] == "https://github.com/a/b"
    assert res.json()["citations"] == [] and res.json()["status"] == "ok"
    assert fake_agent.calls == [("What does main do?", "https://github.com/a/b", [])]


def test_chat_streams_sse_events(client, fake_agent):
    res = client.post(
        "/api/v1/chat/",
        json={
            "question": "What does main do?",
            "repo_url": "https://github.com/a/b",
        },
    )

    events = [e for e in res.text.split("\n\n") if e]
    assert json.loads(events[0].removeprefix("data: "))["node"] == "query_planner"
    assert json.loads(events[1].removeprefix("data: ")) == {
        "type": "answer",
        "content": "answer for https://github.com/a/b",
    }
    assert events[-1] == "data: [DONE]"


def test_chat_passes_conversation_history(client, fake_agent):
    history = [
        {"role": "user", "content": "What does Signer.sign do?"},
        {"role": "assistant", "content": "It signs a value (`signer.py:200`)."},
    ]
    res = client.post(
        "/api/v1/chat/",
        json={
            "question": "And what calls it?",
            "repo_url": "https://github.com/a/b",
            "stream": False,
            "history": history,
        },
    )
    assert res.status_code == 200
    assert fake_agent.calls[-1][2] == history
    assert fake_agent.allow_followup is True
    client.post(
        "/api/v1/chat/",
        json={"question": "Skip it", "repo_url": "https://github.com/a/b", "stream": False, "allow_followup": False},
    )
    assert fake_agent.allow_followup is False
    bad = client.post(
        "/api/v1/chat/",
        json={
            "question": "And?",
            "repo_url": "https://github.com/a/b",
            "history": [{"role": "system", "content": "x"}],
        },
    )
    assert bad.status_code == 422


def test_chat_rejects_invalid_payload(client, fake_agent):
    res = client.post("/api/v1/chat/", json={"question": "hi", "repo_url": "not-a-url"})
    assert res.status_code == 422


def test_index_submits_normalised_url(client, monkeypatch):
    submitted = []

    class FakeTask:
        id = "task-123"

    monkeypatch.setattr(repo_module.process_repository, "delay", lambda url: submitted.append(url) or FakeTask())

    res = client.post("/api/v1/repo/index", json={"repo_url": "https://github.com/a/b.git/"})

    assert res.status_code == 200
    assert res.json()["task_id"] == "task-123"
    assert submitted == ["https://github.com/a/b"]


@pytest.mark.skipif(
    not (Path(__file__).parents[1] / "app" / "static" / "index.html").exists(),
    reason="frontend not built (run `npm run build` in frontend/)",
)
def test_ui_is_served_at_root_without_shadowing_api(client):
    res = client.get("/")
    assert res.status_code == 200
    assert "Codebase RAG" in res.text
    assert client.get("/health").json()["status"] == "healthy"
