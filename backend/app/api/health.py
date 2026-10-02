import asyncio
import logging
import time
from collections.abc import Callable

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from app.services.graph_db import graph_db
from app.services.lexical_db import lexical_db
from app.services.vector_db import vector_db

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Health Diagnostics"])

READINESS_TIMEOUT_SECONDS = 3.0

# Dependency name -> blocking ping that raises on failure.
DEPENDENCIES: dict[str, Callable[[], None]] = {
    "neo4j": graph_db.ping,
    "qdrant": vector_db.ping,
    "redis": lexical_db.ping,
}


@router.get("/health")
async def health() -> dict:
    """Liveness: the process is up and serving HTTP. Deliberately touches no database,
    so a database outage never makes the orchestrator restart a healthy API."""
    return {"status": "healthy"}


async def _check(name: str, ping: Callable[[], None]) -> dict:
    started = time.perf_counter()
    try:
        await asyncio.wait_for(run_in_threadpool(ping), timeout=READINESS_TIMEOUT_SECONDS)
        return {"ok": True, "ms": round((time.perf_counter() - started) * 1000, 1)}
    except TimeoutError:
        return {"ok": False, "error": f"timed out after {READINESS_TIMEOUT_SECONDS}s"}
    except Exception as e:
        logger.warning("Readiness check for %s failed: %s", name, e)
        return {"ok": False, "error": type(e).__name__}


@router.get("/ready")
async def ready() -> JSONResponse:
    """Readiness: every dependency answers within the timeout. 503 otherwise, so load
    balancers and deploy smoke tests stop sending traffic to this instance."""
    names = list(DEPENDENCIES)
    results = await asyncio.gather(*(_check(n, DEPENDENCIES[n]) for n in names))
    checks = dict(zip(names, results, strict=True))
    is_ready = all(c["ok"] for c in checks.values())
    return JSONResponse(
        status_code=200 if is_ready else 503,
        content={"status": "ready" if is_ready else "not_ready", "checks": checks},
    )
