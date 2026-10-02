from typing import Any

from celery.result import AsyncResult
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, HttpUrl

from app.core.urls import normalize_repo_url
from app.services.graph_db import graph_db
from app.workers.celery_app import celery_app
from app.workers.tasks import process_repository

router = APIRouter()


class RepoIndexRequest(BaseModel):
    repo_url: HttpUrl


@router.post("/index")
async def index_repository(request: RepoIndexRequest):
    repo_url = normalize_repo_url(str(request.repo_url))
    task = process_repository.delay(repo_url)

    return {"message": "Repository ingestion task submitted successfully.", "task_id": task.id, "repo_url": repo_url}


@router.get("/status/{task_id}")
async def get_task_status(task_id: str):
    task_result = AsyncResult(task_id, app=celery_app)

    response: dict[str, Any] = {
        "task_id": task_id,
        "status": task_result.state,
    }

    if task_result.state == "PENDING":
        response["message"] = "Task is waiting in the queue for an available worker."

    elif task_result.state in ["CLONING", "PARSING", "EMBEDDING", "STORING", "LINKING"]:
        meta = task_result.info or {}
        response["message"] = meta.get("step", "Processing...")
        response["progress"] = meta

    elif task_result.state == "SUCCESS":
        response["result"] = task_result.result

    elif task_result.state == "FAILURE":
        response["error"] = str(task_result.info)

    return response


@router.get("/graph")
async def get_repository_graph(
    repo_url: str = Query(..., description="Repository URL as used for indexing"),
    limit: int = Query(400, ge=1, le=2000, description="Maximum number of symbols"),
):
    """Symbols and their CALLS / INHERITS / HAS_METHOD edges, for visualisation."""
    try:
        graph_db.connect()
        return graph_db.get_repository_graph(normalize_repo_url(repo_url), limit=limit)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Graph database unavailable: {e}") from e
