import pytest
import redis

from app.services import embeddings as embeddings_module
from app.services.embeddings import CachedEmbeddings, EmbeddingDimensionError


class FakeClient:
    """Stands in for GoogleGenerativeAIEmbeddings; vectors encode the text so order is checkable."""

    def __init__(self, dims=3, fail_times=0):
        self.dims = dims
        self.fail_times = fail_times
        self.requests = []

    def embed_documents(self, texts, task_type=None):
        self.requests.append((list(texts), task_type))
        if self.fail_times:
            self.fail_times -= 1
            raise RuntimeError("503 UNAVAILABLE")
        return [[float(len(t)), 0.5, float(len(self.requests))][: self.dims] for t in texts]


class FakeRedis:
    def __init__(self, broken=False):
        self.store = {}
        self.broken = broken

    def pipeline(self, transaction=False):
        return FakePipeline(self)


class FakePipeline:
    def __init__(self, redis_):
        self.redis = redis_
        self.ops = []

    def getex(self, key, ex=None):
        self.ops.append(lambda: self.redis.store.get(key))

    def set(self, key, value, ex=None):
        self.ops.append(lambda: self.redis.store.__setitem__(key, value))

    def execute(self):
        if self.redis.broken:
            raise redis.ConnectionError("redis down")
        return [op() for op in self.ops]


def _embedder(client=None, cache=None, dims=3):
    return CachedEmbeddings(client or FakeClient(dims), "test-model", dims, cache=cache)


def test_second_call_is_served_from_cache():
    client, cache = FakeClient(), FakeRedis()
    embedder = _embedder(client, cache)

    first = embedder.embed_queries(["where is main", "main entry point"])
    second = embedder.embed_queries(["where is main", "main entry point"])

    assert len(client.requests) == 1
    # Round-trips through float32; these values are exactly representable.
    assert second == first


def test_only_misses_are_sent_and_order_is_kept():
    client, cache = FakeClient(), FakeRedis()
    embedder = _embedder(client, cache)
    embedder.embed_documents(["aa"])

    vectors = embedder.embed_documents(["bbb", "aa", "c"])

    assert client.requests[-1] == (["bbb", "c"], "RETRIEVAL_DOCUMENT")
    assert [v[0] for v in vectors] == [3.0, 2.0, 1.0]


def test_duplicate_texts_in_one_call_are_embedded_once():
    client = FakeClient()
    vectors = _embedder(client).embed_documents(["pass", "pass", "x"])

    assert client.requests == [(["pass", "x"], "RETRIEVAL_DOCUMENT")]
    assert vectors[0] == vectors[1]


def test_queries_and_documents_are_cached_separately():
    client, cache = FakeClient(), FakeRedis()
    embedder = _embedder(client, cache)

    embedder.embed_documents(["def run(): ..."])
    embedder.embed_queries(["def run(): ..."])

    assert [task for _, task in client.requests] == ["RETRIEVAL_DOCUMENT", "RETRIEVAL_QUERY"]


def test_broken_cache_falls_back_to_the_api():
    client = FakeClient()
    vectors = _embedder(client, FakeRedis(broken=True)).embed_queries(["q"])

    assert len(vectors) == 1
    assert len(client.requests) == 1


def test_wrong_dimension_is_a_configuration_error():
    embedder = CachedEmbeddings(FakeClient(dims=2), "test-model", 3)
    with pytest.raises(EmbeddingDimensionError):
        embedder.embed_documents(["x"])


def test_documents_retry_transient_errors_but_queries_do_not(monkeypatch):
    monkeypatch.setattr(embeddings_module.time, "sleep", lambda s: None)

    assert len(_embedder(FakeClient(fail_times=2)).embed_documents(["x"])) == 1
    with pytest.raises(RuntimeError):
        _embedder(FakeClient(fail_times=1)).embed_queries(["x"])


def test_large_inputs_are_split_into_api_sized_batches():
    client = FakeClient()
    embedder = CachedEmbeddings(client, "test-model", 3, batch_size=2)

    assert len(embedder.embed_documents(["a", "bb", "ccc", "dddd", "eeeee"])) == 5
    assert [len(texts) for texts, _ in client.requests] == [2, 2, 1]
