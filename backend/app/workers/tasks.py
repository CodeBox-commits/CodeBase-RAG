import logging
import os
import subprocess
import tempfile
from collections.abc import Callable
from pathlib import Path

from app.core.call_resolver import resolve_relationships
from app.core.parser import CodeParser
from app.core.schemas import ExtractedChunk
from app.core.urls import normalize_repo_url
from app.services.embeddings import CachedEmbeddings, EmbeddingDimensionError, build_embeddings
from app.services.graph_db import graph_db
from app.services.lexical_db import lexical_db
from app.services.vector_db import vector_db
from app.workers.celery_app import celery_app

logger = logging.getLogger(__name__)

# Gemini's per-request maximum; chunks from many files share a request.
EMBED_BATCH_SIZE = 100


class IngestionError(Exception):
    """Raised so Celery records the task as FAILURE instead of a SUCCESS with an error payload."""


ParsedFile = tuple[str, list[ExtractedChunk]]


def embed_chunks(
    embedder: CachedEmbeddings,
    parsed_files: list[ParsedFile],
    batch_size: int = EMBED_BATCH_SIZE,
    on_progress: Callable[[int, int], None] | None = None,
) -> tuple[dict[str, list[list[float]]], set[str]]:
    """Embeds every chunk in cross-file batches.

    Returns the vectors per file (in chunk order) and the files that couldn't be embedded
    because a batch holding one of their chunks failed after retries.
    """
    flat = [(path, chunk) for path, chunks in parsed_files for chunk in chunks]
    vectors_by_file: dict[str, list[list[float]]] = {path: [] for path, _ in parsed_files}
    failed: set[str] = set()

    for i in range(0, len(flat), batch_size):
        batch = flat[i : i + batch_size]
        try:
            vectors = embedder.embed_documents([chunk.source_code for _, chunk in batch])
        except EmbeddingDimensionError as e:
            # Every batch would fail the same way; stop with the real reason.
            raise IngestionError(str(e)) from e
        except Exception as e:
            paths = {path for path, _ in batch}
            logger.warning(f"Embedding failed for {len(batch)} chunks across {len(paths)} files: {e}")
            failed.update(paths)
            continue
        for (path, _), vector in zip(batch, vectors, strict=True):
            vectors_by_file[path].append(vector)
        if on_progress:
            on_progress(min(i + batch_size, len(flat)), len(flat))

    for path in failed:
        vectors_by_file.pop(path, None)
    return vectors_by_file, failed


@celery_app.task(bind=True, name="process_repository")
def process_repository(self, repo_url: str):
    repo_url = normalize_repo_url(repo_url)

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        logger.error("GEMINI_API_KEY is not set.")
        raise IngestionError("GEMINI_API_KEY is not set")

    graph_db.connect()
    lexical_db.connect()

    # The embedder validates every vector's dimension, so no probe embedding is needed here.
    embedder = build_embeddings(
        api_key=api_key,
        model=os.getenv("EMBEDDING_MODEL", "models/gemini-embedding-001"),
        dimensions=vector_db.vector_size,
    )

    try:
        vector_db.connect()
    except Exception as e:
        logger.error(f"Failed to initialize vector DB: {e}", exc_info=True)
        raise IngestionError(f"Vector DB initialization failed: {e}") from e

    logger.info(f"Starting ingestion for {repo_url}")

    graph_db.delete_repository_data(repo_url)
    vector_db.delete_repository(repo_url)
    lexical_db.delete_repository(repo_url)
    graph_db.merge_repository(repo_url)

    self.update_state(state="CLONING", meta={"step": "Cloning repository"})

    with tempfile.TemporaryDirectory() as temp_dir:
        repo_path = Path(temp_dir) / "repo"

        try:
            subprocess.run(
                ["git", "clone", "--depth", "1", repo_url, str(repo_path)],
                check=True,
                capture_output=True,
                text=True,
                timeout=300,
            )
        except subprocess.TimeoutExpired as e:
            logger.error(f"Git clone timed out for {repo_url}.")
            raise IngestionError("Git clone timeout") from e
        except subprocess.CalledProcessError as e:
            logger.error(f"Git clone failed: {e.stderr}")
            raise IngestionError("Invalid repository or access denied") from e

        source_files = [
            f for f in repo_path.rglob("*.py") if not (".venv" in f.parts or ".git" in f.parts or "tests" in f.parts)
        ]

        parser = CodeParser()
        parsed_files: list[ParsedFile] = []
        failed_files_count = 0

        def parse_progress(done: int):
            self.update_state(
                state="PARSING",
                meta={
                    "step": "Parsing the AST",
                    "files_total": len(source_files),
                    "files_done": done,
                    "chunks": sum(len(c) for _, c in parsed_files),
                },
            )

        parse_progress(0)
        for index, file_path in enumerate(source_files, 1):
            if index % 10 == 0:
                parse_progress(index)

            try:
                content = file_path.read_text(encoding="utf-8")
                relative_path = str(file_path.relative_to(repo_path))
                chunks = parser.parse_python_source(relative_path, content)
            except Exception as e:
                logger.warning(f"AST Parsing failed for {file_path.name}: {e!s}")
                failed_files_count += 1
                continue
            if chunks:
                parsed_files.append((relative_path, chunks))

        chunk_total = sum(len(chunks) for _, chunks in parsed_files)

        def embed_progress(done: int, total: int):
            self.update_state(
                state="EMBEDDING",
                meta={
                    "step": "Embedding code chunks",
                    "files_total": len(source_files),
                    "files_done": len(source_files),
                    "chunks": chunk_total,
                    "chunks_done": done,
                    "chunks_total": total,
                },
            )

        embed_progress(0, chunk_total)
        vectors_by_file, embed_failures = embed_chunks(embedder, parsed_files, on_progress=embed_progress)
        failed_files_count += len(embed_failures)

        parsed_files_count = 0
        # Every successfully stored symbol; call edges can only be resolved once all files are known.
        ingested_chunks: list[ExtractedChunk] = []

        for stored, (relative_path, chunks) in enumerate(parsed_files, 1):
            if relative_path in embed_failures:
                continue
            if stored % 5 == 1:
                self.update_state(
                    state="STORING",
                    meta={
                        "step": "Writing to Neo4j, Qdrant and RediSearch",
                        "chunks": chunk_total,
                        "store_total": len(parsed_files),
                        "store_done": stored - 1,
                    },
                )

            try:
                vector_items = [
                    {
                        "name": chunk.qualified_name,
                        "text": chunk.source_code,
                        "type": chunk.type,
                        "language": "python",
                        "start_line": chunk.start_line,
                        "end_line": chunk.end_line,
                        "vector": vector,
                    }
                    for chunk, vector in zip(chunks, vectors_by_file[relative_path], strict=True)
                ]

                graph_db.merge_symbols(repo_url, chunks)
                vector_db.upsert_batch(repo_url, relative_path, vector_items)
                lexical_db.index_batch(repo_url, relative_path, vector_items)
                ingested_chunks.extend(chunks)
                parsed_files_count += 1

            except Exception as e:
                logger.warning(f"Ingestion failed for {relative_path}: {e!s}")
                failed_files_count += 1

        if parsed_files_count == 0:
            if failed_files_count > 0:
                raise IngestionError(f"All {failed_files_count} Python files failed to ingest")
            raise IngestionError("No Python source files found in repository")

        self.update_state(
            state="LINKING", meta={"step": "Resolving calls and inheritance", "symbols": len(ingested_chunks)}
        )

        relationships = resolve_relationships(ingested_chunks)
        graph_db.merge_relationships(repo_url, relationships)

        logger.info(
            f"Ingestion complete. Parsed {parsed_files_count} Python files. Failed {failed_files_count}. "
            f"Edges: {len(relationships.calls)} calls, {len(relationships.inherits)} inherits, "
            f"{len(relationships.has_method)} has_method."
        )

        status = "partial_success" if failed_files_count > 0 else "success"

        return {
            "status": status,
            "parsed_files": parsed_files_count,
            "failed_files": failed_files_count,
            "symbols": len(ingested_chunks),
            "call_edges": len(relationships.calls),
            "inherits_edges": len(relationships.inherits),
            "repo_url": repo_url,
        }
