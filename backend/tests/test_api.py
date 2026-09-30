import json

import pytest
from fastapi.testclient import TestClient

from app.api.v1 import repo as repo_module
from app.main import app
from app.services.agent import get_agent


class FakeAgent:
    def __init__(self):
        self.calls = []

    def run(self, question, repo_url):
        self.calls.append((question, repo_url))
        return f"answer for {repo_url}"


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
    res = client.post("/api/v1/chat/", json={
        "question": "What does main do?",
        "repo_url": "https://github.com/a/b.git",
        "stream": False,
    })

    assert res.status_code == 200
    assert res.json()["repo_url"] == "https://github.com/a/b"
    assert fake_agent.calls == [("What does main do?", "https://github.com/a/b")]


def test_chat_streams_sse_events(client, fake_agent):
    res = client.post("/api/v1/chat/", json={
        "question": "What does main do?",
        "repo_url": "https://github.com/a/b",
    })

    events = [e for e in res.text.split("\n\n") if e]
    assert json.loads(events[0].removeprefix("data: ")) == {
        "type": "token", "content": "answer for https://github.com/a/b",
    }
    assert events[-1] == "data: [DONE]"


def test_chat_rejects_invalid_payload(client, fake_agent):
    res = client.post("/api/v1/chat/", json={"question": "hi", "repo_url": "not-a-url"})
    assert res.status_code == 422


def test_index_submits_normalised_url(client, monkeypatch):
    submitted = []

    class FakeTask:
        id = "task-123"

    monkeypatch.setattr(
        repo_module.process_repository, "delay", lambda url: submitted.append(url) or FakeTask()
    )

    res = client.post("/api/v1/repo/index", json={"repo_url": "https://github.com/a/b.git/"})

    assert res.status_code == 200
    assert res.json()["task_id"] == "task-123"
    assert submitted == ["https://github.com/a/b"]


def test_ui_is_served_at_root_without_shadowing_api(client):
    res = client.get("/")
    assert res.status_code == 200
    assert "Codebase RAG" in res.text
    assert client.get("/health").json()["status"] == "healthy"
