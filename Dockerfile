# syntax=docker/dockerfile:1
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    MEMORY_DB_PATH=/data/memory.db \
    PORT=8080

WORKDIR /app

# Install deps first for better layer caching.
COPY pyproject.toml ./
COPY src ./src
RUN pip install --upgrade pip && pip install .

# Persisted SQLite lives here; docker-compose mounts a named volume at /data.
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --retries=10 --start-period=5s \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8080/health',timeout=2).status==200 else 1)"

# Factory pattern: no app is built at import time (see main.py).
CMD ["uvicorn", "memory_service.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8080"]
