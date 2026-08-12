import logging
from typing import Any, Dict, List

from app.services.vector_db import vector_db
from app.services.lexical_db import lexical_db

logger = logging.getLogger(__name__)

class HybridSearch:
    def __init__(self, rrf_k: int = 60):
        self.rrf_k = rrf_k

    def search(self, query: str, query_vector: List[float], repo_url: str, limit: int = 10) -> List[Dict[str, Any]]:
        vector_results = self._vector_search(query_vector, repo_url)
        lexical_results = lexical_db.search(query, repo_url, limit=20)
        return self._rrf_fuse(vector_results, lexical_results)[:limit]

    def _vector_search(self, query_vector: List[float], repo_url: str) -> List[Dict[str, Any]]:
        vector_db.connect(vector_size=len(query_vector))
        hits = vector_db.client.search(
            collection_name=vector_db.collection_name,
            query_vector=query_vector,
            query_filter=vector_db.build_repo_filter(repo_url),
            limit=20,
        )
        return [
            {**hit.payload, "vector_score": hit.score}
            for hit in hits
        ]

    def _rrf_fuse(self, vector_results, lexical_results):
        fused = {}

        for rank, result in enumerate(vector_results, 1):
            key = self._key(result)
            fused.setdefault(key, {**result, "rrf_score": 0.0, "sources": []})
            fused[key]["rrf_score"] += 1 / (self.rrf_k + rank)
            fused[key]["sources"].append("vector")

        for rank, result in enumerate(lexical_results, 1):
            key = self._key(result)
            fused.setdefault(key, {**result, "rrf_score": 0.0, "sources": []})
            fused[key]["rrf_score"] += 1 / (self.rrf_k + rank)
            fused[key]["sources"].append("bm25")

        return sorted(fused.values(), key=lambda x: x["rrf_score"], reverse=True)

    @staticmethod
    def _key(result):
        return f"{result.get('filepath')}:{result.get('symbol')}:{result.get('start_line')}"

hybrid_search = HybridSearch()