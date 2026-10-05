import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from app.api.health import router as health_router
from app.api.v1.chat import router as chat_router
from app.api.v1.repo import router as repo_router
from app.api.v1.symbols import router as symbols_router
from app.mcp_server import build_routes as build_mcp_routes
from app.mcp_server import mcp
from app.services.graph_db import graph_db
from app.services.vector_db import vector_db


class TraceIDLogFilter(logging.Filter):
    def filter(self, record):
        if not hasattr(record, "trace_id"):
            record.trace_id = "system"
        return True


logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s | %(levelname)s | [%(name)s] | trace_id=%(trace_id)s | %(message)s",
)
# Filter on the root handlers so records from every logger get a trace_id.
for handler in logging.getLogger().handlers:
    handler.addFilter(TraceIDLogFilter())

logger = logging.getLogger("codebase_rag")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing background service connections...")
    try:
        graph_db.connect()
        vector_db.connect()
        logger.info("✅ Database connections verified.")
    except Exception as e:
        logger.critical(f"❌ Initialization warning: Infrastructure connectivity failed: {e}")

    # The MCP endpoint's task group; it lives as long as the app.
    async with mcp.session_manager.run():
        yield

    logger.info("Gracefully tearing down database connection pools...")
    graph_db.close()
    logger.info("Teardown complete.")


app = FastAPI(
    title="Codebase Intelligence RAG Engine",
    description="Enterprise Multi-Database Code Search Engine powered by AST Parsing, Neo4j, Qdrant, and LangGraph.",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs" if os.getenv("ENV") != "production" else None,
    redoc_url=None,
)


class TraceAndTimingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        trace_id = request.headers.get("X-Request-ID", str(uuid.uuid4()))
        start_time = time.perf_counter()

        request.state.trace_id = trace_id

        response = await call_next(request)

        process_time_ms = (time.perf_counter() - start_time) * 1000
        response.headers["X-Request-ID"] = trace_id
        response.headers["X-Process-Time-Ms"] = f"{process_time_ms:.2f}"

        logger.info(
            f"{request.method} {request.url.path} Completed {response.status_code} in {process_time_ms:.2f}ms",
            extra={"trace_id": trace_id},
        )
        return response


app.add_middleware(TraceAndTimingMiddleware)

allowed_origins_raw = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")
allowed_origins = [origin.strip() for origin in allowed_origins_raw.split(",")]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
    max_age=600,
)

app.include_router(health_router)
app.include_router(repo_router, prefix="/api/v1/repo", tags=["Repository Ingestion"])
app.include_router(chat_router, prefix="/api/v1/chat", tags=["Agent Query Engine"])
app.include_router(symbols_router, prefix="/api/v1/symbols", tags=["Code Intelligence"])
# MCP over streamable HTTP at /mcp (see app/mcp_server.py); must precede the "/" UI mount.
app.router.routes.extend(build_mcp_routes())


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    trace_id = getattr(request.state, "trace_id", "unknown")
    logger.error(f"Unhandled exception on route {request.url.path}: {exc}", exc_info=True, extra={"trace_id": trace_id})
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "error": "Internal Server Error",
            "message": "An unexpected error occurred. Please reference the correlation ID.",
            "trace_id": trace_id,
        },
    )


# Mounted last so API routes, /health and /docs take precedence over the UI.
# The UI is build output (frontend `npm run build`); the API also runs without it.
STATIC_DIR = Path(__file__).parent / "static"
if (STATIC_DIR / "index.html").exists():
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="ui")
