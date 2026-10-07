import hashlib
import logging
import os
import re
from collections.abc import Iterable, Sequence
from typing import Any

import redis
from redis.commands.search.field import NumericField, TagField, TextField
from redis.commands.search.index_definition import IndexDefinition, IndexType
from redis.commands.search.query import Query

logger = logging.getLogger(__name__)

DEFAULT_FIELDS = ("symbol", "filepath", "code_text")
MAX_QUERY_TERMS = 16

# Same shape RediSearch indexes as a single token (it splits on punctuation, not on "_").
_TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")

_STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "can",
    "code",
    "does",
    "do",
    "for",
    "from",
    "how",
    "in",
    "is",
    "it",
    "its",
    "of",
    "on",
    "or",
    "that",
    "the",
    "this",
    "to",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
    "with",
    "work",
    "works",
}


class LexicalDB:
    def __init__(self):
        self.url = os.getenv("REDIS_URL", "redis://redis:6379/0")
        self.index_name = os.getenv("REDIS_SEARCH_INDEX", "code_chunks")
        self.key_prefix = "code_chunk:"
        self.client: redis.Redis | None = None

    def _require_client(self) -> redis.Redis:
        """The client, connecting first if needed (callers never see None)."""
        if self.client is None:
            self.connect()
        assert self.client is not None
        return self.client

    def ping(self) -> None:
        """Raises if Redis isn't reachable (used by the readiness probe)."""
        self._require_client().ping()

    def connect(self):
        if self.client is not None:
            return
        try:
            self.client = redis.Redis.from_url(
                self.url,
                decode_responses=True,
            )
            self.client.ping()
            self._ensure_index()
            logger.info(
                "Redis lexical search connected. Index='%s'",
                self.index_name,
            )
        except Exception:
            self.client = None
            logger.exception("Failed to connect to Redis lexical search.")
            raise

    def _ensure_index(self):
        """Create the RediSearch index if it does not already exist."""
        try:
            self._require_client().ft(self.index_name).info()
            return
        except redis.ResponseError:
            pass
        schema = (
            TextField("symbol", weight=5.0),
            TextField("filepath", weight=3.0),
            TextField("code_text", weight=1.0),
            TextField("language"),
            TextField("chunk_type"),
            TagField("repo_url"),
            NumericField("start_line"),
            NumericField("end_line"),
        )

        definition = IndexDefinition(
            prefix=[self.key_prefix],
            index_type=IndexType.HASH,
        )

        self._require_client().ft(self.index_name).create_index(
            list(schema),
            definition=definition,
        )

        logger.info("Created Redis search index '%s'.", self.index_name)

    def index_batch(
        self,
        repo_url: str,
        filepath: str,
        items: list[dict[str, Any]],
    ):
        if not items:
            return

        if self.client is None:
            self.connect()

        pipe = self._require_client().pipeline(transaction=False)

        for item in items:
            key = self._make_key(
                repo_url,
                filepath,
                item["name"],
                int(item.get("start_line", 0)),
            )
            pipe.hset(
                key,
                mapping={
                    "repo_url": repo_url,
                    "filepath": filepath,
                    "symbol": item["name"],
                    "language": item.get("language", "unknown"),
                    "chunk_type": item.get("type", "unknown"),
                    "start_line": int(item.get("start_line", 0)),
                    "end_line": int(item.get("end_line", 0)),
                    "code_text": item.get("text", ""),
                },
            )

        pipe.execute()

    def delete_repository(self, repo_url: str):
        if self.client is None:
            self.connect()

        deleted = 0
        page_size = 1000

        # Always read the first page: deleted docs drop out of the index.
        while True:
            query = Query(f"@repo_url:{{{self._escape_tag(repo_url)}}}").no_content().paging(0, page_size)

            results = self._require_client().ft(self.index_name).search(query)

            if not results.docs:
                break

            pipe = self._require_client().pipeline(transaction=False)

            for doc in results.docs:
                pipe.delete(doc.id)

            pipe.execute()
            deleted += len(results.docs)

        logger.info(
            "Deleted %d lexical chunks for repository %s",
            deleted,
            repo_url,
        )

    def delete_files(self, repo_url: str, paths: list[str]):
        """Removes the BM25 entries of these files only (incremental re-indexing).

        filepath is a TEXT field (tokenised for search), so exact matching happens here: the
        repository's documents are listed by their repo tag and filtered by path.
        """
        if not paths:
            return
        wanted = set(paths)
        doomed: list[str] = []
        page_size, offset = 1000, 0
        while True:
            query = (
                Query(f"@repo_url:{{{self._escape_tag(repo_url)}}}").return_fields("filepath").paging(offset, page_size)
            )
            results = self._require_client().ft(self.index_name).search(query)
            doomed.extend(doc.id for doc in results.docs if getattr(doc, "filepath", None) in wanted)
            offset += page_size
            if offset >= results.total or not results.docs:
                break
        if doomed:
            self._require_client().delete(*doomed)

    def search(
        self,
        terms: list[str],
        repo_url: str,
        limit: int = 20,
        fields: Sequence[str] = DEFAULT_FIELDS,
    ) -> list[dict[str, Any]]:
        """BM25 search for any of `terms` (see `extract_terms`) within one repository."""
        if self.client is None:
            self.connect()

        query_string = self.build_query(terms, repo_url, fields)
        if query_string is None:
            return []

        query = (
            Query(query_string)
            .scorer("BM25STD")
            .with_scores()
            .paging(0, limit)
            .return_fields(
                "repo_url",
                "filepath",
                "symbol",
                "language",
                "chunk_type",
                "start_line",
                "end_line",
                "code_text",
            )
        )

        results = self._require_client().ft(self.index_name).search(query)
        hits = [
            {
                "repo_url": doc.repo_url,
                "filepath": doc.filepath,
                "symbol": doc.symbol,
                "language": doc.language,
                "chunk_type": doc.chunk_type,
                "start_line": int(doc.start_line),
                "end_line": int(doc.end_line),
                "code_text": doc.code_text,
                "score": float(doc.score),
            }
            for doc in results.docs
        ]
        return self.rank_exact_symbols_first(hits, terms)

    def get_chunks(self, repo_url: str, refs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Stored chunks by identity ({"filepath", "symbol", "start_line"}), in `refs` order.

        Lets the graph step pull in the code of symbols that search didn't return.
        Refs with no stored chunk are skipped.
        """
        if not refs:
            return []
        pipe = self._require_client().pipeline(transaction=False)
        for ref in refs:
            pipe.hgetall(self._make_key(repo_url, ref["filepath"], ref["symbol"], int(ref["start_line"])))
        hits = []
        for doc in pipe.execute():
            if not doc:
                continue
            hits.append(
                {
                    "repo_url": doc["repo_url"],
                    "filepath": doc["filepath"],
                    "symbol": doc["symbol"],
                    "language": doc.get("language"),
                    "chunk_type": doc.get("chunk_type"),
                    "start_line": int(doc["start_line"]),
                    "end_line": int(doc["end_line"]),
                    "code_text": doc.get("code_text", ""),
                }
            )
        return hits

    @staticmethod
    def rank_exact_symbols_first(hits: list[dict[str, Any]], terms: list[str]) -> list[dict[str, Any]]:
        # BM25 length normalisation favours short chunks, so a class with a long docstring
        # loses to its own methods on a query for the class name. The definition whose own
        # name is the searched term should always lead.
        wanted = {t.lower() for t in terms}

        def is_exact(hit: dict[str, Any]) -> bool:
            symbol = (hit.get("symbol") or "").lower()
            return symbol in wanted or symbol.rsplit(".", 1)[-1] in wanted

        return sorted(hits, key=lambda hit: not is_exact(hit))

    @staticmethod
    def extract_terms(texts: Iterable[str], max_terms: int = MAX_QUERY_TERMS) -> list[str]:
        """Identifier-like, lower-cased, de-duplicated search terms from free text."""
        terms: list[str] = []
        for text in texts:
            for token in _TOKEN_RE.findall(text or ""):
                term = token.lower()
                if len(term) < 2 or term in _STOPWORDS or term in terms:
                    continue
                terms.append(term)
        return terms[:max_terms]

    @classmethod
    def build_query(
        cls,
        terms: list[str],
        repo_url: str,
        fields: Sequence[str] = DEFAULT_FIELDS,
    ) -> str | None:
        # Terms are OR-ed across all fields so one matching word is enough to be a candidate;
        # BM25 plus the field weights handle ranking.
        safe_terms = [t for t in terms if _TOKEN_RE.fullmatch(t)]
        if not safe_terms or not fields:
            return None
        return f"@repo_url:{{{cls._escape_tag(repo_url)}}} @{'|'.join(fields)}:({'|'.join(safe_terms)})"

    def _make_key(
        self,
        repo_url: str,
        filepath: str,
        name: str,
        start_line: int,
    ) -> str:
        raw = f"{repo_url}::{filepath}::{name}::{start_line}"
        digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        return f"{self.key_prefix}{digest}"

    @staticmethod
    def _escape_tag(value: str) -> str:
        # RediSearch tag queries need every non-alphanumeric char escaped (URLs contain : / - .).
        return "".join(c if c.isalnum() or c == "_" else f"\\{c}" for c in value)


lexical_db = LexicalDB()
