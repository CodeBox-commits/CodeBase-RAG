"""End-to-end ingestion + retrieval against real Neo4j, Qdrant and Redis.

Run with the databases up (docker compose up -d redis qdrant neo4j):
    pytest -m integration

No network and no Gemini: the repository is a local git repo cloned via file://,
and embeddings come from a deterministic bag-of-words fake.
"""

import hashlib
import math
import re
import subprocess
from pathlib import Path

import pytest

from app.services.graph_db import graph_db
from app.services.hybrid_search import hybrid_search
from app.services.lexical_db import lexical_db
from app.services.vector_db import vector_db
from app.workers import tasks

pytestmark = pytest.mark.integration

FILES = {
    "shop/pricing.py": '''
def apply_discount(total, percent):
    """Reduce a total by a percentage."""
    return round_money(total * (1 - percent / 100))

def round_money(value):
    return round(value, 2)
''',
    "shop/cart.py": '''
from shop import pricing

class Cart:
    """A shopping cart."""
    def __init__(self):
        self.items = []

    def total(self):
        return sum(price for _, price in self.items)

    def checkout(self, percent):
        return pricing.apply_discount(self.total(), percent)

class GiftCart(Cart):
    def checkout(self, percent):
        return super().checkout(percent + 5)
''',
}


def fake_vector(text: str, dims: int) -> list[float]:
    vec = [0.0] * dims
    for token in re.findall(r"[a-z_]+", text.lower()):
        vec[int(hashlib.md5(token.encode()).hexdigest(), 16) % dims] += 1.0
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


class FakeEmbedder:
    def __init__(self, dims: int):
        self.dims = dims

    def embed_documents(self, texts):
        return [fake_vector(t, self.dims) for t in texts]

    def embed_queries(self, texts):
        return [fake_vector(t, self.dims) for t in texts]


@pytest.fixture(scope="module")
def indexed_repo(tmp_path_factory):
    repo = tmp_path_factory.mktemp("fixture_repo")
    for rel, source in FILES.items():
        path = repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source)
    git = ["git", "-C", str(repo), "-c", "user.name=ci", "-c", "user.email=ci@example.com"]
    subprocess.run([*git, "init", "-q"], check=True)
    subprocess.run([*git, "add", "."], check=True)
    subprocess.run([*git, "commit", "-q", "-m", "fixture"], check=True)
    repo_url = Path(repo).as_uri()

    mp = pytest.MonkeyPatch()
    mp.setenv("GEMINI_API_KEY", "integration-test")
    mp.setattr(tasks, "build_embeddings", lambda *a, **kw: FakeEmbedder(vector_db.vector_size))
    try:
        result = tasks.process_repository.apply(args=[repo_url]).get(disable_sync_subtasks=False)
        yield repo_url, result
    finally:
        graph_db.delete_repository_data(repo_url)
        vector_db.delete_repository(repo_url)
        lexical_db.delete_repository(repo_url)
        mp.undo()


def test_ingestion_reports_symbols_and_edges(indexed_repo):
    _, result = indexed_repo
    assert result["status"] == "success"
    assert result["parsed_files"] == 2
    # 3 functions/methods in pricing + Cart, Cart.__init__, total, checkout, GiftCart, GiftCart.checkout
    assert result["symbols"] == 8
    assert result["call_edges"] >= 3
    assert result["inherits_edges"] == 1


def test_graph_context_walks_calls_across_files(indexed_repo):
    repo_url, _ = indexed_repo
    rows = graph_db.get_symbol_context(repo_url, anchors=[], names=["Cart.checkout"], max_depth=3)
    assert len(rows) == 1
    calls = {(c["name"], c["hops"]) for c in rows[0]["calls"]}
    assert ("apply_discount", 1) in calls
    assert ("Cart.total", 1) in calls
    assert ("round_money", 2) in calls  # two hops: checkout -> apply_discount -> round_money
    assert rows[0]["owner"] == "Cart"


def test_graph_context_reports_inheritance(indexed_repo):
    repo_url, _ = indexed_repo
    rows = graph_db.get_symbol_context(repo_url, anchors=[], names=["GiftCart"], max_depth=1)
    assert rows[0]["bases"] == ["Cart"]
    assert "GiftCart.checkout" in rows[0]["methods"]


def test_repository_graph_endpoint_data(indexed_repo):
    repo_url, _ = indexed_repo
    graph = graph_db.get_repository_graph(repo_url, limit=50)
    assert graph["total_symbols"] == 8
    types = {e["type"] for e in graph["edges"]}
    assert {"CALLS", "INHERITS", "HAS_METHOD"} <= types


def test_bm25_search_finds_symbol(indexed_repo):
    repo_url, _ = indexed_repo
    hits = lexical_db.search(["apply_discount"], repo_url, limit=5)
    assert hits and hits[0]["symbol"] == "apply_discount"
    assert hits[0]["filepath"] == "shop/pricing.py"


def test_vector_and_hybrid_search_return_repo_scoped_hits(indexed_repo):
    repo_url, _ = indexed_repo
    vec = fake_vector("apply discount percent total", vector_db.vector_size)
    hits = vector_db.search(vec, repo_url, limit=5)
    assert hits and all(h["filepath"].startswith("shop/") for h in hits)

    # Full identifier: RediSearch doesn't split on "_", so "discount" alone misses
    # "apply_discount" (known recall gap: index snake/camel-case parts separately).
    fused = hybrid_search.search([vec], ["apply_discount"], repo_url, limit=5)
    assert fused[0]["symbol"] == "apply_discount"
    assert set(fused[0]["sources"]) == {"vector", "bm25"}


def test_reindex_replaces_instead_of_duplicating(indexed_repo):
    repo_url, first = indexed_repo
    second = tasks.process_repository.apply(args=[repo_url]).get(disable_sync_subtasks=False)
    assert second["symbols"] == first["symbols"]
    assert graph_db.get_repository_graph(repo_url, limit=50)["total_symbols"] == first["symbols"]


def test_readiness_probe_sees_all_real_dependencies():
    from fastapi.testclient import TestClient

    from app.main import app

    res = TestClient(app).get("/ready")
    assert res.status_code == 200, res.json()
    assert set(res.json()["checks"]) == {"neo4j", "qdrant", "redis"}
