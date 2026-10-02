# Build context is the repository root (see docker-compose.yml).

# --- Stage 1: build the React frontend ---------------------------------------
FROM node:24-slim AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# vite.config.ts writes to ../backend/app/static
RUN npm run build

# --- Stage 2: Python API / worker --------------------------------------------
FROM python:3.12-slim

# Prevent Python from writing .pyc files & enable unbuffered logging
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Git is required for repo cloning
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements first to leverage Docker layer caching
COPY backend/requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Bake the reranker model (~34 MB ONNX) into the image so the first question doesn't download it
ENV RERANKER_CACHE_DIR=/opt/flashrank
RUN python -c "from flashrank import Ranker; Ranker(model_name='ms-marco-MiniLM-L-12-v2', cache_dir='/opt/flashrank')"

# Backend code, then the built frontend served by FastAPI at /
COPY backend/ .
COPY --from=frontend /backend/app/static ./app/static

EXPOSE 8000

# Default command runs the FastAPI web server (Docker Compose overrides this for the Celery worker)
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
