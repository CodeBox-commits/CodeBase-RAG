# 1. Use an official, lightweight Python base image
FROM python:3.11-slim

# 2. Prevent Python from writing .pyc files & enable unbuffered logging
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# 3. Install critical OS system dependencies (Git is required for repo cloning)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# 4. Set the container working directory
WORKDIR /app

# 5. Copy requirements first to leverage Docker layer caching
COPY requirements.txt .

# 6. Install Python dependencies
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# 7. Copy the rest of the backend application code
COPY . .

# 8. Expose port 8000 for FastAPI
EXPOSE 8000

# 9. Default command runs the FastAPI web server (Docker Compose will override this for Celery workers)
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]