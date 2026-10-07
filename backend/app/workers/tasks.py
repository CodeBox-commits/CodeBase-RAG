import logging
import os
import subprocess
import tempfile
from collections.abc import Callable
from pathlib import Path

from app.core.call_resolver import resolve_relationships
from app.core.languages import discover_source_files
from app.core.schemas import ExtractedChunk
from app.core.urls import normalize_repo_url
from app.services.embeddings import (
    GEMINI,
    CachedEmbeddings,
    EmbeddingDimensionError,
    EmbeddingSettings,
    build_embeddings,
)
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


# Bump when parsing or call resolution changes what an unchanged file produces: stored
# symbols would no longer match a fresh parse, so the next run rebuilds everything.
INDEX_VERSION = 2


def _git(repo_path: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo_path), *args], check=True, capture_output=True, text=True, timeout=60
    ).stdout


def blob_shas(repo_path: Path) -> dict[str, str]:
    """Git's content hash of every tracked file, by repository-relative path."""
    shas = {}
    for line in _git(repo_path, "ls-files", "-s").splitlines():
        meta, _, path = line.partition("\t")
        parts = meta.split()
        if len(parts) >= 2 and path:
            shas[path] = parts[1]
    return shas


def plan_changes(
    current: dict[str, str], stored: dict[str, str], full: bool
) -> tuple[set[str], set[str], set[str], set[str]]:
    """(added, modified, deleted, unchanged) paths, comparing current blob SHAs with the stored ones."""
    if full:
        return set(current), set(), set(stored) - set(current), set()
    added = {p for p in current if p not in stored}
    modified = {p for p in current if p in stored and stored[p] != current[p]}
    deleted = set(stored) - set(current)
    unchanged = set(current) - added - modified
    return added, modified, deleted, unchanged


def _vector_items(chunks: list[ExtractedChunk], vectors: list[list[float]]) -> list[dict]:
    return [
        {
            "name": chunk.qualified_name,
            "text": chunk.source_code,
            "type": chunk.type,
            "language": chunk.language,
            "start_line": chunk.start_line,
            "end_line": chunk.end_line,
            "vector": vector,
        }
        for chunk, vector in zip(chunks, vectors, strict=True)
    ]


def _remove_files(repo_url: str, paths: list[str]) -> None:
    graph_db.delete_files(repo_url, paths)
    vector_db.delete_files(repo_url, paths)
    lexical_db.delete_files(repo_url, paths)


@celery_app.task(bind=True, name="process_repository")
def process_repository(self, repo_url: str, full: bool = False):
    """Indexes a repository, re-processing only files whose content changed since the last run.

    Every file is re-parsed (cheap) so calls between changed and unchanged files resolve
    correctly, but only new or changed files are embedded and stored. A changed file's old
    data is replaced only once its new data is ready, so the repository never goes empty;
    a file that fails keeps its old data and is retried next time. `full` rebuilds everything.
    """
    repo_url = normalize_repo_url(repo_url)

    settings = EmbeddingSettings.from_env()
    api_key = os.getenv("GEMINI_API_KEY")
    # Only the Gemini embedding provider needs a key; local embeddings are free and offline.
    if settings.provider == GEMINI and not api_key:
        logger.error("GEMINI_API_KEY is not set (required for EMBEDDING_PROVIDER=gemini).")
        raise IngestionError("GEMINI_API_KEY is not set (required for EMBEDDING_PROVIDER=gemini)")

    graph_db.connect()
    lexical_db.connect()

    # The embedder validates every vector's dimension, so no probe embedding is needed here.
    embedder = build_embeddings(settings, api_key=api_key)

    try:
        vector_db.connect()
    except Exception as e:
        logger.error(f"Failed to initialize vector DB: {e}", exc_info=True)
        raise IngestionError(f"Vector DB initialization failed: {e}") from e

    state = graph_db.get_index_state(repo_url)
    # No record of file hashes (first run, or an index from before File nodes) or a parser
    # change since: nothing stored can be trusted to match a fresh parse.
    if state is None or state["index_version"] != INDEX_VERSION or not state["files"]:
        full = True
    mode = "full" if full else "incremental"
    logger.info(f"Starting {mode} ingestion for {repo_url}")
    graph_db.merge_repository(repo_url)

    self.update_state(state="CLONING", meta={"step": "Cloning repository", "mode": mode})

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

        commit = _git(repo_path, "rev-parse", "HEAD").strip()
        shas = blob_shas(repo_path)
        source_files = [(f, lang, str(f.relative_to(repo_path))) for f, lang in discover_source_files(repo_path)]
        current = {rel: shas.get(rel, "") for _, _, rel in source_files}

        if not full and state is not None and state["commit"] == commit and state["files"] == current:
            counts = graph_db.count_repository(repo_url)
            logger.info(f"{repo_url} is up to date at {commit[:8]}.")
            return {
                "status": "success",
                "mode": "up_to_date",
                "commit": commit,
                "parsed_files": len(current),
                "failed_files": 0,
                "files": {"added": 0, "modified": 0, "deleted": 0, "unchanged": len(current)},
                "embedded_chunks": 0,
                "repo_url": repo_url,
                **counts,
            }

        stored_files = graph_db.repository_files(repo_url) | set(state["files"] if state else {})
        added, modified, deleted, unchanged = plan_changes(
            current, {p: (state["files"].get(p, "") if state else "") for p in stored_files}, full
        )
        changed = added | modified

        # Parse everything: unchanged files' calls are needed to re-link the whole graph.
        parsed: dict[str, list[ExtractedChunk]] = {}
        failed: set[str] = set()

        def parse_progress(done: int):
            self.update_state(
                state="PARSING",
                meta={
                    "step": "Parsing source files",
                    "mode": mode,
                    "files_total": len(source_files),
                    "files_done": done,
                    "files_changed": len(changed),
                    "chunks": sum(len(c) for c in parsed.values()),
                },
            )

        parse_progress(0)
        for index, (file_path, language, rel) in enumerate(source_files, 1):
            if index % 10 == 0:
                parse_progress(index)
            try:
                parsed[rel] = language.parse(rel, file_path.read_text(encoding="utf-8"))
            except Exception as e:
                logger.warning(f"Parsing failed for {rel}: {e!s}")
                failed.add(rel)

        to_embed: list[ParsedFile] = [(rel, parsed[rel]) for rel in sorted(changed) if parsed.get(rel)]
        chunk_total = sum(len(chunks) for _, chunks in to_embed)

        def embed_progress(done: int, total: int):
            self.update_state(
                state="EMBEDDING",
                meta={
                    "step": "Embedding changed code" if mode == "incremental" else "Embedding code chunks",
                    "mode": mode,
                    "files_total": len(source_files),
                    "files_done": len(source_files),
                    "files_changed": len(changed),
                    "chunks": chunk_total,
                    "chunks_done": done,
                    "chunks_total": total,
                },
            )

        embed_progress(0, chunk_total)
        vectors_by_file, embed_failures = embed_chunks(embedder, to_embed, on_progress=embed_progress)
        failed |= embed_failures

        stored_ok: set[str] = set()
        changed_list = sorted(changed - failed)
        # Every changed file's new data is parsed and embedded by now, so its old data can go.
        # One batch (not per file): the BM25 delete scans the repository's entries.
        if replaced := sorted(set(changed_list) & stored_files):
            _remove_files(repo_url, replaced)
        for done, rel in enumerate(changed_list, 1):
            if done % 5 == 1:
                self.update_state(
                    state="STORING",
                    meta={
                        "step": "Writing to Neo4j, Qdrant and RediSearch",
                        "mode": mode,
                        "chunks": chunk_total,
                        "store_total": len(changed_list),
                        "store_done": done - 1,
                    },
                )
            chunks = parsed.get(rel) or []
            try:
                if chunks:
                    items = _vector_items(chunks, vectors_by_file[rel])
                    graph_db.merge_symbols(repo_url, chunks)
                    vector_db.upsert_batch(repo_url, rel, items)
                    lexical_db.index_batch(repo_url, rel, items)
                stored_ok.add(rel)
            except Exception as e:
                logger.warning(f"Ingestion failed for {rel}: {e!s}")
                failed.add(rel)

        if deleted:
            _remove_files(repo_url, sorted(deleted))

        in_graph = (unchanged - failed) | stored_ok
        linked_chunks = [chunk for rel in sorted(in_graph) for chunk in parsed.get(rel, [])]
        if not linked_chunks:
            if failed:
                raise IngestionError(f"All {len(failed)} source files failed to ingest")
            raise IngestionError("No supported source files found in repository")

        self.update_state(
            state="LINKING",
            meta={"step": "Resolving calls and inheritance", "mode": mode, "symbols": len(linked_chunks)},
        )
        # Edges cross files, so a change anywhere can add or remove links everywhere: re-link all.
        relationships = resolve_relationships(linked_chunks)
        graph_db.delete_relationships(repo_url)
        graph_db.merge_relationships(repo_url, relationships)

        # Failed files keep their previous hash, so the next run tries them again.
        recorded = {rel: current[rel] for rel in in_graph}
        graph_db.save_index_state(repo_url, commit, INDEX_VERSION, recorded, removed=sorted(deleted))

        logger.info(
            f"Ingestion complete ({mode}). {len(changed)} changed, {len(deleted)} deleted, "
            f"{len(unchanged)} unchanged, {len(failed)} failed. Edges: {len(relationships.calls)} calls, "
            f"{len(relationships.inherits)} inherits, {len(relationships.has_method)} has_method."
        )

        return {
            "status": "partial_success" if failed else "success",
            "mode": mode,
            "commit": commit,
            "parsed_files": sum(1 for rel in in_graph if parsed.get(rel)),
            "failed_files": len(failed),
            "files": {
                "added": len(added & stored_ok),
                "modified": len(modified & stored_ok),
                "deleted": len(deleted),
                "unchanged": len(unchanged - failed),
            },
            "embedded_chunks": sum(len(parsed.get(rel) or []) for rel in stored_ok),
            "symbols": len(linked_chunks),
            "call_edges": len(relationships.calls),
            "inherits_edges": len(relationships.inherits),
            "repo_url": repo_url,
        }
