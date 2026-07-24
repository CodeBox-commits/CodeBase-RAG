import os
import tempfile
import subprocess
import logging
from pathlib import Path
from app.workers.celery_app import celery_app
from app.services.graph_db import graph_db
from app.services.vector_db import vector_db
from app.core.parser import CodeParser
from langchain_google_genai import GoogleGenerativeAIEmbeddings

logger = logging.getLogger(__name__)

@celery_app.task(bind=True, name="process_repository")
def process_repository(self, repo_url: str):
    graph_db.connect()
    
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
        sample_emb = embeddings.embed_query("test")
        vector_db.connect(vector_size=len(sample_emb))
    except Exception as e:
        logger.error(f"Failed to initialize embeddings/vector_db connection: {e}")
        return {"status": "failed", "error": f"Vector DB initialization failed: {e}"}
    
    logger.info(f"Starting ingestion for {repo_url}")
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
                embeddings_list = embeddings.embed_documents(texts_to_embed)
                
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
                
                parsed_files_count += 1
                
            except Exception as e:
                logger.warning(f"AST Parsing & Ingestion failed for {file_path.name}: {str(e)}")
                continue
        
        logger.info(f"Ingestion complete. Parsed {parsed_files_count} Python files.")
        return {"status": "success", "parsed_files": parsed_files_count, "repo_url": repo_url}