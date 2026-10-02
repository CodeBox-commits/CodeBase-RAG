import json
import logging
from typing import AsyncGenerator
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, HttpUrl, Field
from starlette.concurrency import iterate_in_threadpool, run_in_threadpool
from app.services.agent import CodeAgent, get_agent
from app.core.urls import normalize_repo_url

logger = logging.getLogger(__name__)

router = APIRouter()


class ChatQueryRequest(BaseModel):
    question: str = Field(
        ..., 
        min_length=3, 
        max_length=2048, 
        description="The user's technical query about the codebase."
    )
    repo_url: HttpUrl = Field(
        ..., 
        description="The target repository HTTP(S) clone URL."
    )
    stream: bool = Field(
        default=True, 
        description="Whether to stream tokens in SSE format."
    )


class ChatQueryResponse(BaseModel):
    question: str
    repo_url: str
    answer: str


async def stream_agent_response(agent: CodeAgent, question: str, repo_url: str) -> AsyncGenerator[str, None]:
    try:
        # Each pipeline step is sent as it finishes, so the UI can animate real progress.
        async for event in iterate_in_threadpool(agent.run_stream(question, repo_url)):
            yield f"data: {json.dumps(event, default=str)}\n\n"
        yield "data: [DONE]\n\n"

    except Exception as e:
        logger.error(f"Error streaming agent execution: {e}", exc_info=True)
        error_payload = json.dumps({"type": "error", "message": "An error occurred during agent execution."})
        yield f"data: {error_payload}\n\n"


@router.post(
    "/",
    response_model=ChatQueryResponse,
    responses={
        200: {
            "content": {"text/event-stream": {}},
            "description": "Streams response tokens as Server-Sent Events when `stream=true`."
        }
    },
    status_code=status.HTTP_200_OK
)
async def ask_codebase(
    payload: ChatQueryRequest,
    agent: CodeAgent = Depends(get_agent)
):

    str_repo_url = normalize_repo_url(str(payload.repo_url))

    if payload.stream:
        return StreamingResponse(
            stream_agent_response(agent, payload.question, str_repo_url),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no"  
            }
        )

    try:
        answer = await run_in_threadpool(agent.run, payload.question, str_repo_url)
        return ChatQueryResponse(
            question=payload.question,
            repo_url=str_repo_url,
            answer=answer
        )
    except Exception as e:
        logger.error(f"Failed execution for query on {str_repo_url}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="An internal error occurred while executing the code intelligence pipeline."
        )