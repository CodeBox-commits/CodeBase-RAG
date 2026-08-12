import os
import hashlib
import logging
from typing import List, Dict, Any, Optional
import redis
from redis.commands.search.field import TextField, TagField, NumericField
from redis.commands.search import IndexDefinition, IndexType
from redis.commands.search.query import Query

logger = logging.getLogger(__name__)


class LexicalDB:
    def __init__(self):
        self.host = os.getenv("REDIS_HOST", "redis")
        self.port = int(os.getenv("REDIS_PORT", "6379"))
        self.index_name = os.getenv("REDIS_SEARCH_INDEX", "code_chunks")
        self.key_prefix = "code_chunk:"
        self.client: Optional[redis.Redis] = None

    def connect(self):
        if self.client is not None:
            return
        try:
            self.client = redis.Redis(
                host=self.host,
                port=self.port,
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
            self.client.ft(self.index_name).info()
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

        self.client.ft(self.index_name).create_index(
            schema,
            definition=definition,
        )

        logger.info("Created Redis search index '%s'.", self.index_name)

    def index_batch(
        self,
        repo_url: str,
        filepath: str,
        items: List[Dict[str, Any]],
    ):
        if not items:
            return

        if self.client is None:
            self.connect()

        pipe = self.client.pipeline(transaction=False)

        for item in items:
            key = self._make_key(
                repo_url,
                filepath,
                item["name"],
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

        query = Query(
            f"@repo_url:{{{self._escape_tag(repo_url)}}}"
        ).no_content()

        results = self.client.ft(self.index_name).search(query)

        if not results.docs:
            return

        pipe = self.client.pipeline(transaction=False)

        for doc in results.docs:
            pipe.delete(doc.id)

        pipe.execute()

        logger.info(
            "Deleted %d lexical chunks for repository %s",
            len(results.docs),
            repo_url,
        )

    def search(
        self,
        query_text: str,
        repo_url: str,
        limit: int = 20,
    ) -> List[Dict[str, Any]]:
        if self.client is None:
            self.connect()

        if not query_text.strip():
            return []

        escaped_query = self._escape_text(query_text)
        escaped_repo = self._escape_tag(repo_url)

        query = Query(
            f"@repo_url:{{{escaped_repo}}} "
            f"(@symbol:{escaped_query} "
            f"@filepath:{escaped_query} "
            f"@code_text:{escaped_query})"
        ).scorer("BM25STD").with_scores().paging(0, limit).return_fields(
            "repo_url",
            "filepath",
            "symbol",
            "language",
            "chunk_type",
            "start_line",
            "end_line",
            "code_text",
        )

        results = self.client.ft(self.index_name).search(query)
        return [
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

    def _make_key(
        self,
        repo_url: str,
        filepath: str,
        name: str,
    ) -> str:
        raw = f"{repo_url}::{filepath}::{name}"
        digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        return f"{self.key_prefix}{digest}"

    @staticmethod
    def _escape_tag(value: str) -> str:
        for char in r'\{}|,.<>[]':
            value = value.replace(char, f"\\{char}")
        return value

    @staticmethod
    def _escape_text(value: str) -> str:
        special_chars = r',.<>{}[]"\'`:;!@#$%^&*()-+=~|'

        for char in special_chars:
            value = value.replace(char, f"\\{char}")

        return value


lexical_db = LexicalDB()