import hashlib
import logging
import os
import re
import threading
import time
from array import array
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol

import redis

logger = logging.getLogger(__name__)

QUERY_TASK = "RETRIEVAL_QUERY"
DOCUMENT_TASK = "RETRIEVAL_DOCUMENT"

DEFAULT_CACHE_TTL_SECONDS = 30 * 24 * 3600


class EmbeddingDimensionError(ValueError):
    """The model returned vectors of the wrong size: a configuration error, not a transient one."""


# ---------------------------------------------------------------------------
# Settings shared by the API, the worker and Qdrant, so all three always agree.

LOCAL = "local"
GEMINI = "gemini"

# provider -> (default model, its native dimensions)
PROVIDER_DEFAULTS: dict[str, tuple[str, int]] = {
    # Free and offline: ~67 MB ONNX model, runs on CPU via FastEmbed (no PyTorch).
    LOCAL: ("BAAI/bge-small-en-v1.5", 384),
    # Gemini API: needs GEMINI_API_KEY and counts against its rate limits.
    GEMINI: ("models/gemini-embedding-001", 768),
}


@dataclass(frozen=True)
class EmbeddingSettings:
    provider: str
    model: str
    dimensions: int

    @classmethod
    def from_env(cls) -> "EmbeddingSettings":
        provider = os.getenv("EMBEDDING_PROVIDER", LOCAL).strip().lower()
        if provider not in PROVIDER_DEFAULTS:
            raise ValueError(f"EMBEDDING_PROVIDER must be one of {sorted(PROVIDER_DEFAULTS)}, got {provider!r}")
        default_model, default_dims = PROVIDER_DEFAULTS[provider]
        model = os.getenv("EMBEDDING_MODEL") or default_model
        if os.getenv("VECTOR_SIZE"):
            dimensions = int(os.environ["VECTOR_SIZE"])
        elif model == default_model:
            dimensions = default_dims
        else:
            raise ValueError(f"Set VECTOR_SIZE for non-default embedding model {model!r}")
        return cls(provider, model, dimensions)

    @property
    def collection_name(self) -> str:
        """One Qdrant collection per model: vectors from different models are never comparable,
        so switching models starts a fresh collection instead of silently mixing them."""
        slug = re.sub(r"[^a-z0-9]+", "-", self.model.lower()).strip("-")
        return f"code_{slug}_{self.dimensions}"


# ---------------------------------------------------------------------------
# Backends. Both expose LangChain's embed_documents(texts, task_type=...) signature,
# so caching, batching and retries below work the same for either.


class EmbeddingBackend(Protocol):
    def embed_documents(self, texts: list[str], task_type: str | None = None) -> list[list[float]]: ...


class FastEmbedBackend:
    """Local embeddings with FastEmbed (ONNX Runtime, CPU). The model loads lazily on first
    use, once per process, and is downloaded once into cache_dir (baked into the Docker image)."""

    def __init__(
        self,
        model: str,
        cache_dir: str | None = None,
        threads: int | None = None,
        batch_size: int = 16,
    ):
        self.model = model
        self.cache_dir = cache_dir
        self.threads = threads
        # Transformer memory grows with batch x sequence_length^2: 100 chunks of 512 tokens
        # can need >1 GB at once and get the worker OOM-killed. Small batches cap the peak;
        # on CPU they cost almost no throughput.
        self.batch_size = batch_size
        self._embedder: Any = None
        self._lock = threading.Lock()

    def _get(self) -> Any:
        if self._embedder is None:
            with self._lock:
                if self._embedder is None:
                    from fastembed import TextEmbedding

                    self._embedder = TextEmbedding(self.model, cache_dir=self.cache_dir, threads=self.threads)
                    logger.info("Local embedding model '%s' loaded.", self.model)
        return self._embedder

    def embed_documents(self, texts: list[str], task_type: str | None = None) -> list[list[float]]:
        embedder = self._get()
        # Retrieval models embed questions and passages differently (e.g. bge adds an
        # instruction prefix to queries); FastEmbed applies the right one per call.
        if task_type == QUERY_TASK:
            vectors = embedder.query_embed(texts, batch_size=self.batch_size)
        else:
            vectors = embedder.passage_embed(texts, batch_size=self.batch_size)
        return [vector.tolist() for vector in vectors]


class CachedEmbeddings:
    """Batched embeddings behind a Redis cache keyed by model, dimensions, task type and text.

    Identical text is only ever embedded once per TTL: repeated questions skip the query
    embedding call, and re-indexing a repository only pays for chunks whose code changed.
    The cache is an optimisation only; if Redis is unavailable every text goes to the model.
    """

    def __init__(
        self,
        client: EmbeddingBackend,
        model: str,
        dimensions: int,
        cache: redis.Redis | None = None,
        ttl_seconds: int = DEFAULT_CACHE_TTL_SECONDS,
        batch_size: int = 100,
    ):
        self.client = client
        self.model = model
        self.dimensions = dimensions
        self.cache = cache
        self.ttl_seconds = ttl_seconds
        self.batch_size = batch_size

    def embed_queries(self, texts: Sequence[str]) -> list[list[float]]:
        # Not retried: the Google SDK already retries 429/503, and local models don't fail transiently.
        return self._embed(texts, QUERY_TASK, attempts=1)

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        return self._embed(texts, DOCUMENT_TASK, attempts=3)

    def _embed(self, texts: Sequence[str], task_type: str, attempts: int) -> list[list[float]]:
        if not texts:
            return []

        keys = [self._key(task_type, text) for text in texts]
        vectors = self._cache_get(keys)
        cache_hits = sum(vector is not None for vector in vectors)

        # Identical texts in one call (e.g. repeated one-line methods) are embedded once.
        pending: dict[str, str] = {}
        for key, text, vector in zip(keys, texts, vectors, strict=True):
            if vector is None:
                pending.setdefault(key, text)

        if pending:
            pending_keys = list(pending)
            fresh = dict(
                zip(pending_keys, self._call_api([pending[k] for k in pending_keys], task_type, attempts), strict=True)
            )
            self._cache_set(fresh)
            vectors = [vector if vector is not None else fresh[key] for key, vector in zip(keys, vectors, strict=True)]

        logger.info(
            "Embedded %d %s texts: %d from cache, %d sent to the model",
            len(texts),
            task_type,
            cache_hits,
            len(pending),
        )
        # Every slot is filled by now: either a cache hit or a fresh embedding.
        return [vector for vector in vectors if vector is not None]

    def _call_api(self, texts: list[str], task_type: str, attempts: int) -> list[list[float]]:
        vectors: list[list[float]] = []
        for i in range(0, len(texts), self.batch_size):
            batch = texts[i : i + self.batch_size]
            for attempt in range(attempts):
                try:
                    result = self.client.embed_documents(batch, task_type=task_type)
                    break
                except Exception:
                    if attempt == attempts - 1:
                        raise
                    time.sleep(2**attempt)

            for vector in result:
                if len(vector) != self.dimensions:
                    raise EmbeddingDimensionError(
                        f"Embedding model '{self.model}' returned {len(vector)} dimensions, "
                        f"expected {self.dimensions}. Check EMBEDDING_PROVIDER, EMBEDDING_MODEL and VECTOR_SIZE."
                    )
            vectors.extend(result)
        return vectors

    def _key(self, task_type: str, text: str) -> str:
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        return f"emb:v1:{self.model}:{self.dimensions}:{task_type}:{digest}"

    def _cache_get(self, keys: list[str]) -> list[list[float] | None]:
        if self.cache is None:
            return [None] * len(keys)
        try:
            pipe = self.cache.pipeline(transaction=False)
            for key in keys:
                # GETEX refreshes the TTL, so code that is still being indexed stays cached.
                pipe.getex(key, ex=self.ttl_seconds)
            raw = pipe.execute()
        except redis.RedisError as e:
            logger.warning("Embedding cache read failed, embedding without cache: %s", e)
            return [None] * len(keys)
        return [self._decode(value) for value in raw]

    def _cache_set(self, vectors: dict[str, list[float]]):
        if self.cache is None or not vectors:
            return
        try:
            pipe = self.cache.pipeline(transaction=False)
            for key, vector in vectors.items():
                pipe.set(key, array("f", vector).tobytes(), ex=self.ttl_seconds)
            pipe.execute()
        except redis.RedisError as e:
            logger.warning("Embedding cache write failed: %s", e)

    def _decode(self, value: bytes | None) -> list[float] | None:
        # Stored as packed float32 (~3 KB for 768 dims) rather than JSON (~15 KB).
        if value is None:
            return None
        vector = array("f")
        vector.frombytes(value)
        return vector.tolist() if len(vector) == self.dimensions else None


class GeminiBackend:
    """Adapter giving the Gemini client the same narrow interface as the local backend."""

    def __init__(self, api_key: str, model: str, dimensions: int):
        from langchain_google_genai import GoogleGenerativeAIEmbeddings
        from pydantic import SecretStr

        self.client = GoogleGenerativeAIEmbeddings(
            model=model,
            api_key=SecretStr(api_key),
            output_dimensionality=dimensions,
        )

    def embed_documents(self, texts: list[str], task_type: str | None = None) -> list[list[float]]:
        return self.client.embed_documents(texts, task_type=task_type)


def build_backend(settings: EmbeddingSettings, api_key: str | None = None) -> EmbeddingBackend:
    if settings.provider == LOCAL:
        return FastEmbedBackend(
            settings.model,
            cache_dir=os.getenv("FASTEMBED_CACHE_DIR"),
            batch_size=int(os.getenv("LOCAL_EMBED_BATCH_SIZE", "16")),
        )
    if not api_key:
        raise ValueError("EMBEDDING_PROVIDER=gemini needs GEMINI_API_KEY")
    return GeminiBackend(api_key, settings.model, settings.dimensions)


def build_embeddings(settings: EmbeddingSettings | None = None, api_key: str | None = None) -> CachedEmbeddings:
    """Embeddings for the configured provider, behind the Redis cache.
    EMBEDDING_CACHE_TTL_SECONDS=0 disables the cache."""
    settings = settings or EmbeddingSettings.from_env()
    ttl_seconds = int(os.getenv("EMBEDDING_CACHE_TTL_SECONDS", str(DEFAULT_CACHE_TTL_SECONDS)))
    cache = None
    if ttl_seconds > 0:
        # from_url doesn't connect yet; short timeouts keep a dead Redis from stalling requests.
        cache = redis.Redis.from_url(
            os.getenv("REDIS_URL", "redis://redis:6379/0"),
            socket_connect_timeout=1,
            socket_timeout=2,
        )
    return CachedEmbeddings(
        build_backend(settings, api_key),
        settings.model,
        settings.dimensions,
        cache=cache,
        ttl_seconds=ttl_seconds,
    )
