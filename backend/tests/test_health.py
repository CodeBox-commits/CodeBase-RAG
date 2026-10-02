import pytest
from fastapi.testclient import TestClient

from app.api import health
from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


def test_liveness_never_touches_databases(client, monkeypatch):
    def boom():
        raise AssertionError("liveness must not ping dependencies")

    monkeypatch.setattr(health, "DEPENDENCIES", {"neo4j": boom})
    res = client.get("/health")
    assert res.status_code == 200 and res.json() == {"status": "healthy"}


def test_ready_when_every_dependency_answers(client, monkeypatch):
    monkeypatch.setattr(health, "DEPENDENCIES", {"neo4j": lambda: None, "redis": lambda: None})
    res = client.get("/ready")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ready"
    assert body["checks"]["neo4j"]["ok"] and "ms" in body["checks"]["neo4j"]


def test_not_ready_names_the_failing_dependency(client, monkeypatch):
    def down():
        raise ConnectionError("refused")

    monkeypatch.setattr(health, "DEPENDENCIES", {"neo4j": lambda: None, "qdrant": down})
    res = client.get("/ready")
    assert res.status_code == 503
    assert res.json()["checks"]["qdrant"] == {"ok": False, "error": "ConnectionError"}


def test_slow_dependency_times_out(client, monkeypatch):
    import time

    monkeypatch.setattr(health, "READINESS_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(health, "DEPENDENCIES", {"redis": lambda: time.sleep(0.3)})
    res = client.get("/ready")
    assert res.status_code == 503
    assert "timed out" in res.json()["checks"]["redis"]["error"]
