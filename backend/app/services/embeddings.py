import hashlib
import logging
import os
import time
from array import array
from collections.abc import Sequence

import redis
from langchain_google_genai import GoogleGenerativeAIEmbeddings

logger = logging.getLogger(__name__)

QUERY_TASK = "RETRIEVAL_QUERY"
DOCUMENT_TASK = "RETRIEVAL_DOCUMENT"

DEFAULT_CACHE_TTL_SECONDS = 30 * 24 * 3600


class EmbeddingDimensionError(ValueError):
    """The model returned vectors of the wrong size: a configuration error, not a transient one."""


class CachedEmbeddings:
    """Batched embeddings behind a Redis cache keyed by model, dimensions, task type and text.

    Identical text is only ever embedded once per TTL: repeated questions skip the query
    embedding call, and re-indexing a repository only pays for chunks whose code changed.
    The cache is an optimisation only; if Redis is unavailable every text goes to the API.
    """

    def __init__(
        self,
        client: GoogleGenerativeAIEmbeddings,
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
        # The Google SDK already retries 429/503, so a failed query embedding isn't retried here.
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
        for key, text, vector in zip(keys, texts, vectors):
            if vector is None:
                pending.setdefault(key, text)

        if pending:
            pending_keys = list(pending)
            fresh = dict(zip(pending_keys, self._call_api([pending[k] for k in pending_keys], task_type, attempts)))
            self._cache_set(fresh)
            vectors = [vector if vector is not None else fresh[key] for key, vector in zip(keys, vectors)]

        logger.info(
            "Embedded %d %s texts: %d from cache, %d sent to the API",
            len(texts),
            task_type,
            cache_hits,
            len(pending),
        )
        return vectors

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
                        f"expected {self.dimensions}. Check EMBEDDING_MODEL and VECTOR_SIZE."
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


def build_embeddings(api_key: str, model: str, dimensions: int) -> CachedEmbeddings:
    """Gemini embeddings with the Redis cache; EMBEDDING_CACHE_TTL_SECONDS=0 disables the cache."""
    ttl_seconds = int(os.getenv("EMBEDDING_CACHE_TTL_SECONDS", str(DEFAULT_CACHE_TTL_SECONDS)))
    cache = None
    if ttl_seconds > 0:
        # from_url doesn't connect yet; short timeouts keep a dead Redis from stalling requests.
        cache = redis.Redis.from_url(
            os.getenv("REDIS_URL", "redis://redis:6379/0"),
            socket_connect_timeout=1,
            socket_timeout=2,
        )
    client = GoogleGenerativeAIEmbeddings(
        model=model,
        google_api_key=api_key,
        output_dimensionality=dimensions,
    )
    return CachedEmbeddings(client, model, dimensions, cache=cache, ttl_seconds=ttl_seconds)
