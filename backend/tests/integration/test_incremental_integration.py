"""Incremental re-indexing against real Neo4j, Qdrant and Redis.

A local git repository is indexed, then edited and committed between runs; each run
must touch only what changed and leave the rest (and the links into it) intact.
"""

import hashlib
import math
import re
import subprocess
from pathlib import Path

import pytest
from qdrant_client.http import models

from app.services.graph_db import graph_db
from app.services.lexical_db import lexical_db
from app.services.vector_db import vector_db
from app.workers import tasks

pytestmark = pytest.mark.integration

PRICING = """
def apply_discount(total, percent):
    return round_money(total * (1 - percent / 100))

def round_money(value):
    return round(value, 2)
"""
CART = """
from shop import pricing

class Cart:
    def checkout(self, total):
        return pricing.apply_discount(total, 10)
"""


class RecordingEmbedder:
    """Deterministic bag-of-words vectors that also record what was embedded."""

    def __init__(self, dims):
        self.dims = dims
        self.documents: list[str] = []

    def _vector(self, text):
        vec = [0.0] * self.dims
        for token in re.findall(r"[a-z_]+", text.lower()):
            vec[int(hashlib.md5(token.encode()).hexdigest(), 16) % self.dims] += 1.0
        norm = math.sqrt(sum(x * x for x in vec)) or 1.0
        return [x / norm for x in vec]

    def embed_documents(self, texts):
        self.documents.extend(texts)
        return [self._vector(t) for t in texts]

    def embed_queries(self, texts):
        return [self._vector(t) for t in texts]


@pytest.fixture
def repo(tmp_path, monkeypatch):
    path = tmp_path / "shop_repo"
    (path / "shop").mkdir(parents=True)
    (path / "shop" / "pricing.py").write_text(PRICING)
    (path / "shop" / "cart.py").write_text(CART)
    git = ["git", "-C", str(path), "-c", "user.name=ci", "-c", "user.email=ci@example.com"]
    subprocess.run([*git, "init", "-q"], check=True)

    def commit(message):
        subprocess.run([*git, "add", "-A"], check=True)
        subprocess.run([*git, "commit", "-q", "-m", message], check=True)

    commit("initial")
    embedder = RecordingEmbedder(vector_db.vector_size)
    monkeypatch.setattr(tasks, "build_embeddings", lambda *a, **kw: embedder)
    repo_url = Path(path).as_uri()
    try:
        yield repo_url, path, commit, embedder
    finally:
        graph_db.delete_repository_data(repo_url)
        vector_db.delete_repository(repo_url)
        lexical_db.delete_repository(repo_url)


def index(repo_url, full=False):
    return tasks.process_repository.apply(args=[repo_url, full]).get(disable_sync_subtasks=False)


def symbols(repo_url):
    return {(r["filepath"], r["name"]) for r in graph_db.get_repository_graph(repo_url, limit=100)["nodes"]}


def vector_count(repo_url, filepath):
    flt = models.Filter(
        must=[
            models.FieldCondition(key="repo_url", match=models.MatchValue(value=repo_url)),
            models.FieldCondition(key="filepath", match=models.MatchValue(value=filepath)),
        ]
    )
    return vector_db._require_client().count(vector_db.collection_name, count_filter=flt, exact=True).count


def calls(repo_url):
    graph = graph_db.get_repository_graph(repo_url, limit=100)
    return {(e["source"].split("::")[1], e["target"].split("::")[1]) for e in graph["edges"] if e["type"] == "CALLS"}


def test_reindexing_touches_only_what_changed(repo):
    repo_url, path, commit, embedder = repo

    # 1. First run: everything is new.
    first = index(repo_url)
    assert first["mode"] == "full" and first["files"]["added"] == 2
    assert first["embedded_chunks"] == 4 and len(embedder.documents) == 4
    assert ("Cart.checkout", "apply_discount") in calls(repo_url)

    # 2. Nothing changed: no parsing, no embedding.
    embedder.documents.clear()
    same = index(repo_url)
    assert same["mode"] == "up_to_date" and same["symbols"] == 4
    assert embedder.documents == []

    # 3. One file edited: only it is re-embedded; links from the untouched file survive.
    (path / "shop" / "pricing.py").write_text(PRICING + "\ndef tax(total):\n    return round_money(total * 0.2)\n")
    commit("add tax")
    embedder.documents.clear()
    edited = index(repo_url)
    assert edited["mode"] == "incremental"
    assert edited["files"] == {"added": 0, "modified": 1, "deleted": 0, "unchanged": 1}
    assert edited["embedded_chunks"] == 3 and all("Cart" not in text for text in embedder.documents)
    assert ("shop/pricing.py", "tax") in symbols(repo_url)
    assert ("Cart.checkout", "apply_discount") in calls(repo_url)  # cart.py -> pricing.py, re-linked
    assert ("tax", "round_money") in calls(repo_url)
    assert vector_count(repo_url, "shop/pricing.py") == 3 and vector_count(repo_url, "shop/cart.py") == 2
    assert lexical_db.search(["tax"], repo_url, limit=5)[0]["symbol"] == "tax"

    # 4. A file deleted: gone from all three stores, nothing re-embedded.
    (path / "shop" / "cart.py").unlink()
    commit("drop cart")
    embedder.documents.clear()
    dropped = index(repo_url)
    assert dropped["files"]["deleted"] == 1 and embedder.documents == []
    assert not any(p == "shop/cart.py" for p, _ in symbols(repo_url))
    assert vector_count(repo_url, "shop/cart.py") == 0
    assert all(h["filepath"] != "shop/cart.py" for h in lexical_db.search(["cart", "checkout"], repo_url, limit=10))

    # 5. Full rebuild on request, without duplicating anything.
    rebuilt = index(repo_url, full=True)
    assert rebuilt["mode"] == "full" and rebuilt["symbols"] == 3
    assert vector_count(repo_url, "shop/pricing.py") == 3
    state = graph_db.get_index_state(repo_url)
    assert set(state["files"]) == {"shop/pricing.py"} and state["index_version"] == tasks.INDEX_VERSION


def test_an_older_index_version_forces_a_full_rebuild(repo):
    repo_url, _, _, _ = repo
    index(repo_url)
    graph_db.save_index_state(repo_url, "old-commit", tasks.INDEX_VERSION - 1, {}, removed=[])
    assert index(repo_url)["mode"] == "full"
