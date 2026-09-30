import os
import time
import tempfile
import subprocess
import logging
from pathlib import Path
from typing import List
from app.workers.celery_app import celery_app
from app.services.graph_db import graph_db
from app.services.vector_db import vector_db
from app.services.lexical_db import lexical_db
from app.core.parser import CodeParser
from app.core.call_resolver import resolve_relationships
from app.core.schemas import ExtractedChunk
from app.core.urls import normalize_repo_url
from langchain_google_genai import GoogleGenerativeAIEmbeddings

logger = logging.getLogger(__name__)


class IngestionError(Exception):
    """Raised so Celery records the task as FAILURE instead of a SUCCESS with an error payload."""


@celery_app.task(bind=True, name="process_repository")
def process_repository(self, repo_url: str):
    repo_url = normalize_repo_url(repo_url)

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        logger.error("GEMINI_API_KEY is not set.")
        raise IngestionError("GEMINI_API_KEY is not set")

    graph_db.connect()
    lexical_db.connect()

    embedding_model = os.getenv("EMBEDDING_MODEL", "models/gemini-embedding-001")

    embeddings = GoogleGenerativeAIEmbeddings(
      model=embedding_model,
      google_api_key=api_key,
      output_dimensionality=vector_db.vector_size,
    )

    try:
      sample_embedding = embeddings.embed_query("dimension_check")
      vector_db.connect(vector_size=len(sample_embedding))
    except Exception as e:
       logger.error(
          f"Failed to initialize embeddings/vector DB: {e}",
          exc_info=True
       )
       raise IngestionError(f"Vector DB initialization failed: {e}") from e

    logger.info(f"Starting ingestion for {repo_url}")

    graph_db.delete_repository_data(repo_url)
    vector_db.delete_repository(repo_url)
    lexical_db.delete_repository(repo_url)
    graph_db.merge_repository(repo_url)

    self.update_state(state="CLONING", meta={"step": "Downloading repository"})

    with tempfile.TemporaryDirectory() as temp_dir:
        repo_path = Path(temp_dir) / "repo"

        try:
            subprocess.run(
                ["git", "clone", "--depth", "1", repo_url, str(repo_path)],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=300
            )
        except subprocess.TimeoutExpired as e:
            logger.error(f"Git clone timed out for {repo_url}.")
            raise IngestionError("Git clone timeout") from e
        except subprocess.CalledProcessError as e:
            logger.error(f"Git clone failed: {e.stderr}")
            raise IngestionError("Invalid repository or access denied") from e

        self.update_state(state="PARSING", meta={"step": "Extracting AST definitions & vectors"})

        parser = CodeParser()
        parsed_files_count = 0
        failed_files_count = 0
        # Every successfully stored symbol; call edges can only be resolved once all files are known.
        ingested_chunks: List[ExtractedChunk] = []

        for file_path in repo_path.rglob("*.py"):
            if ".venv" in file_path.parts or ".git" in file_path.parts or "tests" in file_path.parts:
                continue

            try:
                content = file_path.read_text(encoding="utf-8")
                relative_path = str(file_path.relative_to(repo_path))

                chunks = parser.parse_python_source(relative_path, content)
                if not chunks:
                    continue

                texts_to_embed = [chunk.source_code for chunk in chunks]

                embeddings_list = []
                batch_size = 100
                for i in range(0, len(texts_to_embed), batch_size):
                    batch = texts_to_embed[i:i+batch_size]
                    for attempt in range(3):
                        try:
                            embeddings_list.extend(embeddings.embed_documents(batch))
                            break
                        except Exception as e:
                            if attempt == 2:
                                raise e
                            time.sleep(2 ** attempt)

                vector_items = []
                for chunk, embedding in zip(chunks, embeddings_list):
                    vector_items.append({
                        "name": chunk.qualified_name,
                        "text": chunk.source_code,
                        "type": chunk.type,
                        "language": "python",
                        "start_line": chunk.start_line,
                        "end_line": chunk.end_line,
                        "vector": embedding
                    })

                graph_db.merge_symbols(repo_url, chunks)
                if vector_items:
                    vector_db.upsert_batch(repo_url, relative_path, vector_items)
                    lexical_db.index_batch(repo_url, relative_path, vector_items)
                ingested_chunks.extend(chunks)
                parsed_files_count += 1

            except Exception as e:
                logger.warning(f"AST Parsing & Ingestion failed for {file_path.name}: {str(e)}")
                failed_files_count += 1
                continue

        if parsed_files_count == 0:
            if failed_files_count > 0:
                raise IngestionError(f"All {failed_files_count} Python files failed to ingest")
            raise IngestionError("No Python source files found in repository")

        self.update_state(state="LINKING", meta={"step": "Resolving calls and inheritance"})

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
            "repo_url": repo_url,
        }
