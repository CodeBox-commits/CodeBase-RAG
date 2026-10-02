# syntax=docker/dockerfile:1
# Build context is the repository root (see docker-compose.yml and the CI/release workflows).

# --- Stage 1: frontend ----------------------------------------------------------
# Runs on the build machine's native platform even for multi-arch builds: the output
# is static files, identical everywhere, so there's no reason to build it under emulation.
FROM --platform=$BUILDPLATFORM node:26-slim AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# vite.config.ts writes to ../backend/app/static
RUN npm run build

# --- Stage 2: Python dependencies + reranker model -------------------------------
FROM python:3.12-slim AS deps
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
COPY backend/requirements.txt .
RUN pip install -r requirements.txt
# Bake the reranker model (~34 MB ONNX) so the first question doesn't download it.
RUN python -c "from flashrank import Ranker; Ranker(model_name='ms-marco-MiniLM-L-12-v2', cache_dir='/opt/flashrank')"

# --- Stage 3: runtime --------------------------------------------------------------
# Only the finished virtualenv, the model and the app code: no compilers, no pip cache.
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH \
    RERANKER_CACHE_DIR=/opt/flashrank

# git is needed at runtime to clone repositories. Non-root user with a fixed UID.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --create-home --home-dir /home/app app

COPY --from=deps /opt/venv /opt/venv
COPY --from=deps /opt/flashrank /opt/flashrank

WORKDIR /app
# Code stays owned by root: the app user can read and run it but not modify it.
COPY backend/ .
COPY --from=frontend /backend/app/static ./app/static

USER app
EXPOSE 8000

# Healthchecks are defined per service in compose: the same image also runs the
# Celery worker, which has no HTTP port.
# --proxy-headers: behind Caddy, client IPs and https scheme come from X-Forwarded-* headers.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
