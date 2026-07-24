import os
from celery import Celery

REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")

celery_app = Celery(
    "git_rag_workers",
    broker=REDIS_URL,
    backend=REDIS_URL,
    include=["app.workers.tasks"]
)

celery_app.conf.update(
    task_serialization="json",
    result_serialization="json",
    accept_content=["json"],

    task_acks_late=True,
    task_reject_on_worker_lost=True,

    worker_prefetch_multiplier=1,
    worker_max_tasks_per_child=10,

    task_soft_time_limit=600,
    task_time_limit=720,
)