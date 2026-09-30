import logging
from typing import Any, Dict, List, Optional, Sequence, Tuple

from app.services.vector_db import vector_db
from app.services.lexical_db import lexical_db, DEFAULT_FIELDS

logger = logging.getLogger(__name__)

RankedList = Tuple[str, List[Dict[str, Any]]]


class HybridSearch:
    def __init__(self, rrf_k: int = 60, candidates_per_list: int = 20):
        self.rrf_k = rrf_k
        self.candidates_per_list = candidates_per_list

    def search(
        self,
        query_vectors: List[List[float]],
        lexical_terms: List[str],
        repo_url: str,
        limit: int = 10,
        score_threshold: Optional[float] = None,
        lexical_fields: Sequence[str] = DEFAULT_FIELDS,
    ) -> List[Dict[str, Any]]:
        """One vector list per query embedding plus one BM25 list, fused with RRF."""
        ranked_lists: List[RankedList] = [
            ("vector", vector_db.search(
                vector,
                repo_url,
                limit=self.candidates_per_list,
                score_threshold=score_threshold,
            ))
            for vector in query_vectors
        ]

        if lexical_terms:
            try:
                ranked_lists.append((
                    "bm25",
                    lexical_db.search(
                        lexical_terms,
                        repo_url,
                        limit=self.candidates_per_list,
                        fields=lexical_fields,
                    ),
                ))
            except Exception as e:
                # Lexical is a recall booster; don't lose the vector results over it.
                logger.warning("Lexical search failed, continuing with vector results only: %s", e)

        return self.fuse(ranked_lists)[:limit]

    def fuse(self, ranked_lists: List[RankedList]) -> List[Dict[str, Any]]:
        """Reciprocal Rank Fusion.

        Every returned result has the same shape:
        - score: fused RRF score normalised to 0..1 (1.0 = ranked first in every list)
        - rrf_score: the raw RRF sum
        - sources: which retrievers found it
        - vector_score / bm25_score: best raw score from that retriever, when present
        """
        fused: Dict[str, Dict[str, Any]] = {}

        for source, results in ranked_lists:
            for rank, result in enumerate(results, 1):
                key = self._key(result)
                entry = fused.setdefault(key, {**result, "rrf_score": 0.0, "sources": []})
                entry["rrf_score"] += 1 / (self.rrf_k + rank)
                if source not in entry["sources"]:
                    entry["sources"].append(source)
                raw_key = f"{source}_score"
                raw_score = result.get("score")
                if raw_score is not None:
                    entry[raw_key] = max(entry.get(raw_key, raw_score), raw_score)

        max_possible = len(ranked_lists) / (self.rrf_k + 1) if ranked_lists else 1.0
        for entry in fused.values():
            entry["score"] = entry["rrf_score"] / max_possible

        return sorted(fused.values(), key=lambda x: x["rrf_score"], reverse=True)

    @staticmethod
    def _key(result):
        return f"{result.get('filepath')}:{result.get('symbol')}:{result.get('start_line')}"

hybrid_search = HybridSearch()
