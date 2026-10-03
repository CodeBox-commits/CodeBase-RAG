import numpy as np
import pytest

from app.services import embeddings as emb
from app.services.embeddings import (
    DOCUMENT_TASK,
    QUERY_TASK,
    EmbeddingSettings,
    FastEmbedBackend,
    build_backend,
)


@pytest.fixture
def clean_env(monkeypatch):
    for var in ("EMBEDDING_PROVIDER", "EMBEDDING_MODEL", "VECTOR_SIZE"):
        monkeypatch.delenv(var, raising=False)
    return monkeypatch


# --- settings ---------------------------------------------------------------


def test_local_bge_small_is_the_free_default(clean_env):
    s = EmbeddingSettings.from_env()
    assert (s.provider, s.model, s.dimensions) == ("local", "BAAI/bge-small-en-v1.5", 384)


def test_gemini_provider_defaults(clean_env):
    clean_env.setenv("EMBEDDING_PROVIDER", "Gemini")
    s = EmbeddingSettings.from_env()
    assert (s.provider, s.model, s.dimensions) == ("gemini", "models/gemini-embedding-001", 768)


def test_each_model_gets_its_own_collection(clean_env):
    local = EmbeddingSettings.from_env()
    clean_env.setenv("EMBEDDING_PROVIDER", "gemini")
    gemini = EmbeddingSettings.from_env()
    assert local.collection_name == "code_baai-bge-small-en-v1-5_384"
    assert gemini.collection_name == "code_models-gemini-embedding-001_768"


def test_custom_model_requires_explicit_dimensions(clean_env):
    clean_env.setenv("EMBEDDING_MODEL", "BAAI/bge-base-en-v1.5")
    with pytest.raises(ValueError, match="VECTOR_SIZE"):
        EmbeddingSettings.from_env()
    clean_env.setenv("VECTOR_SIZE", "768")
    assert EmbeddingSettings.from_env().dimensions == 768


def test_unknown_provider_is_rejected(clean_env):
    clean_env.setenv("EMBEDDING_PROVIDER", "openai")
    with pytest.raises(ValueError, match="EMBEDDING_PROVIDER"):
        EmbeddingSettings.from_env()


# --- backends -----------------------------------------------------------------


class FakeTextEmbedding:
    def __init__(self):
        self.calls = []

    def query_embed(self, texts, batch_size=None):
        self.calls.append(("query", list(texts)))
        return (np.array([1.0, 0.0]) for _ in texts)

    def passage_embed(self, texts, batch_size=None):
        self.calls.append(("passage", list(texts)))
        return (np.array([0.0, 1.0]) for _ in texts)


def test_fastembed_routes_queries_and_passages_to_the_right_encoder():
    backend = FastEmbedBackend("BAAI/bge-small-en-v1.5")
    fake = FakeTextEmbedding()
    backend._embedder = fake

    assert backend.embed_documents(["where is x"], task_type=QUERY_TASK) == [[1.0, 0.0]]
    assert backend.embed_documents(["def x(): ..."], task_type=DOCUMENT_TASK) == [[0.0, 1.0]]
    assert [kind for kind, _ in fake.calls] == ["query", "passage"]


def test_fastembed_model_loads_once(monkeypatch):
    loads = []

    class FakeModule:
        @staticmethod
        def TextEmbedding(model, cache_dir=None, threads=None):
            loads.append(model)
            return FakeTextEmbedding()

    monkeypatch.setitem(__import__("sys").modules, "fastembed", FakeModule)
    backend = FastEmbedBackend("BAAI/bge-small-en-v1.5")
    backend.embed_documents(["a"], task_type=DOCUMENT_TASK)
    backend.embed_documents(["b"], task_type=QUERY_TASK)
    assert loads == ["BAAI/bge-small-en-v1.5"]


def test_local_backend_needs_no_api_key(clean_env):
    assert isinstance(build_backend(EmbeddingSettings.from_env(), api_key=None), FastEmbedBackend)


def test_gemini_backend_requires_api_key(clean_env):
    clean_env.setenv("EMBEDDING_PROVIDER", "gemini")
    with pytest.raises(ValueError, match="GEMINI_API_KEY"):
        build_backend(EmbeddingSettings.from_env(), api_key=None)


def test_ingestion_with_local_embeddings_does_not_require_gemini_key(clean_env, monkeypatch):
    from app.workers import tasks

    clean_env.delenv("GEMINI_API_KEY", raising=False)

    class Stop(Exception):
        pass

    # Getting as far as connecting to the graph DB proves the key check was skipped.
    monkeypatch.setattr(tasks.graph_db, "connect", lambda: (_ for _ in ()).throw(Stop()))
    with pytest.raises(Stop):
        tasks.process_repository.run("https://github.com/a/b")


def test_ingestion_with_gemini_embeddings_still_requires_key(clean_env):
    from app.workers import tasks

    clean_env.setenv("EMBEDDING_PROVIDER", "gemini")
    clean_env.delenv("GEMINI_API_KEY", raising=False)
    with pytest.raises(tasks.IngestionError, match="GEMINI_API_KEY"):
        tasks.process_repository.run("https://github.com/a/b")


def test_cached_embeddings_work_unchanged_with_local_backend():
    backend = FastEmbedBackend("m")
    backend._embedder = FakeTextEmbedding()
    cached = emb.CachedEmbeddings(backend, "m", 2)
    assert cached.embed_queries(["q1", "q2"]) == [[1.0, 0.0], [1.0, 0.0]]
    assert cached.embed_documents(["d"]) == [[0.0, 1.0]]
