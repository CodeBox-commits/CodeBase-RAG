import os
import uuid
import time
import logging
from typing import List, Dict, Any, Optional
from qdrant_client import QdrantClient
from qdrant_client.http import models
from qdrant_client.http.exceptions import UnexpectedResponse

logger = logging.getLogger(__name__)

class QdrantService:
    def __init__(self):
        self.host = os.getenv("QDRANT_HOST", "qdrant")
        self.port = int(os.getenv("QDRANT_PORT", 6333))
        self.collection_name = os.getenv("QDRANT_COLLECTION", "code_snippets")
        self.vector_size = int(os.getenv("VECTOR_SIZE", 768))
        self.client = None

    def connect(self, vector_size: int = None):
        if self.client:
            if vector_size and vector_size != self.vector_size:
                raise ValueError(f"Vector size mismatch: requested {vector_size}, but already connected with {self.vector_size}")
            return
            
        if vector_size:
            self.vector_size = vector_size
            
        try:
            self.client = QdrantClient(host=self.host, port=self.port)
            self._ensure_collection_exists()
            logger.info(f"✅ Qdrant Connected & Collection '{self.collection_name}' Verified (dim: {self.vector_size}).")
        except Exception as e:
            logger.error(f"❌ Failed to connect to Qdrant on {self.host}:{self.port}")
            raise e
        
    @staticmethod
    def build_repo_filter(repo_url: str) -> Optional[models.Filter]:
      if not repo_url:
         return None

      return models.Filter(
         must=[models.FieldCondition(key="repo_url", match=models.MatchValue(value=repo_url))]
      )
    def _ensure_collection_exists(self):
        try:
            collection = self.client.get_collection(self.collection_name)
            if collection.config.params.vectors.size != self.vector_size:
                raise ValueError(f"Qdrant collection '{self.collection_name}' has dimension {collection.config.params.vectors.size}, but {self.vector_size} is required.")
        except UnexpectedResponse as e:
            if e.status_code == 404:
                logger.info(f"Creating Qdrant collection: {self.collection_name} (dim: {self.vector_size})")
                self.client.create_collection(
                    collection_name=self.collection_name,
                    vectors_config=models.VectorParams(
                        size=self.vector_size,
                        distance=models.Distance.COSINE
                    )
                )
            else:
                raise e

    def search(
        self,
        query_vector: List[float],
        repo_url: str,
        limit: int = 20,
        score_threshold: Optional[float] = None,
    ) -> List[Dict[str, Any]]:
        self.connect(vector_size=len(query_vector))
        hits = self.client.query_points(
            collection_name=self.collection_name,
            query=query_vector,
            query_filter=self.build_repo_filter(repo_url),
            limit=limit,
            score_threshold=score_threshold,
        ).points
        return [
            {
                "symbol": hit.payload.get("symbol"),
                "filepath": hit.payload.get("filepath"),
                "language": hit.payload.get("language"),
                "chunk_type": hit.payload.get("chunk_type"),
                "start_line": hit.payload.get("start_line"),
                "end_line": hit.payload.get("end_line"),
                "code_text": hit.payload.get("code_text", ""),
                "score": hit.score,
            }
            for hit in hits
        ]

    def _generate_deterministic_uuid(self, unique_string: str) -> str:
        return str(uuid.uuid5(uuid.NAMESPACE_URL, unique_string))

    def delete_repository(self, repo_url: str):
        if not self.client:
            self.connect()
        try:
            self.client.delete(
                collection_name=self.collection_name,
                points_selector=models.Filter(
                    must=[models.FieldCondition(key="repo_url", match=models.MatchValue(value=repo_url))]
                )
            )
            logger.info(f"Deleted vector embeddings for repo: {repo_url}")
        except Exception as e:
            logger.error(f"Failed to delete repository data from Qdrant: {e}")

    def upsert_batch(self, repo_url: str, filepath: str, items: List[Dict[str, Any]]):
        if not items:
            return

        points = []
        for item in items:
            actual_size = len(item["vector"])
            if actual_size != self.vector_size:
                logger.warning(
                    f"Skipping '{item['name']}': Dimension mismatch. "
                    f"Expected {self.vector_size}, got {actual_size}."
                )
                continue

            unique_key = f"{repo_url}::{filepath}::{item['name']}::{item.get('type')}::{item.get('start_line')}"
            point_id = self._generate_deterministic_uuid(unique_key)
            
            payload = {
               "repo_url": repo_url,
               "filepath": filepath,
               "symbol": item["name"],
               "language": item.get("language"),
               "chunk_type": item.get("type"),
               "start_line": item.get("start_line"),
               "end_line": item.get("end_line"),
               "code_text": item["text"],
          }
            
            points.append(
                models.PointStruct(id=point_id, vector=item["vector"], payload=payload)
            )

        BATCH_SIZE = 250
        MAX_RETRIES = 3

        for i in range(0, len(points), BATCH_SIZE):
            chunk = points[i:i + BATCH_SIZE]
            
            for attempt in range(MAX_RETRIES):
                try:
                    self.client.upsert(
                        collection_name=self.collection_name,
                        points=chunk,
                        wait=False
                    )
                    break
                except Exception as e:
                    if attempt == MAX_RETRIES - 1:
                        logger.error(f"Failed to upsert chunk after {MAX_RETRIES} attempts: {e}")
                        raise
                    
                    sleep_time = 2 ** attempt
                    logger.warning(f"Qdrant upsert failed. Retrying in {sleep_time}s... (Attempt {attempt + 1})")
                    time.sleep(sleep_time)

vector_db = QdrantService()