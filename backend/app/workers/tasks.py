import os
import time
import tempfile
import subprocess
import logging
from pathlib import Path
from app.workers.celery_app import celery_app
from app.services.graph_db import graph_db
from app.services.vector_db import vector_db
from app.services.lexical_db import lexical_db
from app.core.parser import CodeParser
from langchain_google_genai import GoogleGenerativeAIEmbeddings

logger = logging.getLogger(__name__)

def normalize_repo_url(url: str) -> str:
    url = str(url).strip()
    if url.endswith(".git"):
        url = url[:-4]
    return url.rstrip("/")

@celery_app.task(bind=True, name="process_repository")
def process_repository(self, repo_url: str):
    repo_url = normalize_repo_url(repo_url)
    graph_db.connect()
    lexical_db.connect()
    
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        logger.error("GEMINI_API_KEY is not set.")
        return {"status": "failed", "error": "GEMINI_API_KEY is not set"}
    

    embedding_model = os.getenv("EMBEDDING_MODEL", "models/text-embedding-004")

    embeddings = GoogleGenerativeAIEmbeddings(
      model=embedding_model,
      google_api_key=api_key
    )

    try:
      sample_embedding = embeddings.embed_query("dimension_check")
      vector_db.connect(vector_size=len(sample_embedding))
    except Exception as e:
       logger.error(
          f"Failed to initialize embeddings/vector DB: {e}",
          exc_info=True
       )
       return {
          "status": "failed",
          "error": f"Vector DB initialization failed: {str(e)}"
       }

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
        except subprocess.TimeoutExpired:
            logger.error(f"Git clone timed out for {repo_url}.")
            return {"status": "failed", "error": "Git clone timeout"}
        except subprocess.CalledProcessError as e:
            logger.error(f"Git clone failed: {e.stderr}")
            return {"status": "failed", "error": "Invalid repository or access denied"}

        self.update_state(state="PARSING", meta={"step": "Extracting AST definitions & vectors"})

        parser = CodeParser()
        parsed_files_count = 0
        failed_files_count = 0

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
                    chunk_data = chunk.model_dump()
                    graph_db.merge_function(repo_url, relative_path, chunk_data)

                    vector_items.append({
                        "name": chunk.name,
                        "text": chunk.source_code,
                        "type": chunk.type,
                        "language": "python",
                        "start_line": chunk.start_line,
                        "end_line": chunk.end_line,
                        "vector": embedding 
                    })
                
                if vector_items:
                    vector_db.upsert_batch(repo_url, relative_path, vector_items)
                    lexical_db.index_batch(repo_url, relative_path, vector_items)
                parsed_files_count += 1
                
            except Exception as e:
                logger.warning(f"AST Parsing & Ingestion failed for {file_path.name}: {str(e)}")
                failed_files_count += 1
                continue
        
        logger.info(f"Ingestion complete. Parsed {parsed_files_count} Python files. Failed {failed_files_count}.")
        
        if parsed_files_count == 0 and failed_files_count > 0:
            status = "failed"
        elif failed_files_count > 0:
            status = "partial_success"
        else:
            status = "success"
            
        return {"status": status, "parsed_files": parsed_files_count, "failed_files": failed_files_count, "repo_url": repo_url}