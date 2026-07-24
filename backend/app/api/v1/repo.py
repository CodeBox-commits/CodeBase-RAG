from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, HttpUrl
from celery.result import AsyncResult
from typing import Dict, Any
from app.workers.celery_app import celery_app
from app.workers.tasks import process_repository

router = APIRouter()

class RepoIndexRequest(BaseModel):
    repo_url: HttpUrl

@router.post("/index")
async def index_repository(request: RepoIndexRequest):
    task = process_repository.delay(str(request.repo_url))
    
    return {
        "message": "Repository ingestion task submitted successfully.",
        "task_id": task.id,
        "repo_url": str(request.repo_url)
    }

@router.get("/status/{task_id}")
async def get_task_status(task_id: str):
    task_result = AsyncResult(task_id, app=celery_app)
    
    response: Dict[str, Any] = {
        "task_id": task_id,
        "status": task_result.state,
    }

    if task_result.state == "PENDING":
        response["message"] = "Task is waiting in the queue for an available worker."
    
    elif task_result.state in ["CLONING", "PARSING"]:
        meta = task_result.info or {}
        response["message"] = meta.get("step", "Processing...")
        
    elif task_result.state == "SUCCESS":
        response["result"] = task_result.result
        
    elif task_result.state == "FAILURE":
        response["error"] = str(task_result.info)
        
    return response