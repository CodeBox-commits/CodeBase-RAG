import logging
import os
import threading
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "ms-marco-MiniLM-L-12-v2"


class CrossEncoderReranker:
    """Second-stage reranking with a local cross-encoder (FlashRank / ONNX, CPU-only).

    Retrieval (vector + BM25 fused with RRF) only knows each hit's *rank* in its lists. The
    cross-encoder reads the question and each candidate together and scores how well the code
    answers it. No API calls, so it costs no LLM quota (~0.15s for 24 candidates on CPU).

    The final score blends the cross-encoder with the retrieval score, so strong exact-symbol
    and BM25 matches aren't thrown away when the model is unsure about code. If the model can't
    load, hits keep their retrieval order: reranking is an improvement, never a hard dependency.
    """

    def __init__(
        self,
        model_name: str = DEFAULT_MODEL,
        cache_dir: str | None = None,
        weight: float = 0.75,
        max_length: int = 512,
        snippet_max_lines: int = 40,
        ranker: Any = None,
    ):
        self.model_name = model_name
        self.cache_dir = cache_dir or os.path.expanduser("~/.cache/flashrank")
        self.weight = min(max(weight, 0.0), 1.0)
        self.max_length = max_length
        self.snippet_max_lines = snippet_max_lines
        self._ranker = ranker
        self._load_error: str | None = None
        self._lock = threading.Lock()

    @classmethod
    def from_env(cls) -> Optional["CrossEncoderReranker"]:
        model = os.getenv("RERANKER_MODEL", DEFAULT_MODEL)
        if model.lower() in ("", "none", "off", "false", "0"):
            return None
        return cls(
            model_name=model,
            cache_dir=os.getenv("RERANKER_CACHE_DIR"),
            weight=float(os.getenv("RERANK_WEIGHT", "0.75")),
        )

    def _get_ranker(self):
        if self._ranker is not None or self._load_error:
            return self._ranker
        with self._lock:
            if self._ranker is None and not self._load_error:
                try:
                    from flashrank import Ranker

                    self._ranker = Ranker(
                        model_name=self.model_name,
                        cache_dir=self.cache_dir,
                        max_length=self.max_length,
                        log_level="WARNING",
                    )
                    logger.info("Reranker '%s' loaded.", self.model_name)
                except Exception as e:
                    self._load_error = f"{type(e).__name__}: {e}"
                    logger.error("Reranker failed to load, keeping retrieval order: %s", e)
        return self._ranker

    def passage(self, hit: dict[str, Any]) -> str:
        # Symbol and path first: they carry a lot of meaning and survive truncation.
        lines = (hit.get("code_text") or "").splitlines()[: self.snippet_max_lines]
        header = f"{hit.get('symbol')} ({hit.get('chunk_type') or 'code'}) in {hit.get('filepath')}"
        return header + "\n" + "\n".join(lines)

    def rerank(
        self, question: str, hits: list[dict[str, Any]], top_k: int
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Returns the top_k hits in reranked order, plus info about what happened."""
        info: dict[str, Any] = {"model": self.model_name, "candidates": len(hits), "applied": False}
        for rank, hit in enumerate(hits, 1):
            hit["retrieval_rank"] = rank
            hit["retrieval_score"] = hit.get("score", 0.0)
        if not hits:
            return [], info

        ranker = self._get_ranker()
        if ranker is None:
            info["error"] = self._load_error or "reranker unavailable"
            return hits[:top_k], info

        started = time.perf_counter()
        try:
            from flashrank import RerankRequest

            passages = [{"id": i, "text": self.passage(h)} for i, h in enumerate(hits)]
            scored = ranker.rerank(RerankRequest(query=question, passages=passages))
        except Exception as e:
            logger.error("Reranking failed, keeping retrieval order: %s", e, exc_info=True)
            info["error"] = f"{type(e).__name__}: {e}"
            return hits[:top_k], info

        for item in scored:
            hit = hits[int(item["id"])]
            hit["rerank_score"] = float(item["score"])
            hit["score"] = self.weight * hit["rerank_score"] + (1 - self.weight) * hit["retrieval_score"]

        ranked = sorted(hits, key=lambda h: h.get("score", 0.0), reverse=True)
        info.update(applied=True, ms=round((time.perf_counter() - started) * 1000, 1), weight=self.weight)
        return ranked[:top_k], info
