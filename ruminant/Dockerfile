FROM python:3.13-slim

# llama-server (a recent llama.cpp build, needed for Gemma 4) is copied in from the server: see README.md
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY llama /opt/llama
COPY app.py hub.py llama.py ruminant.py ./
RUN useradd --no-create-home --uid 10001 appuser
USER appuser

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
    CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8000/api/ruminant/health', timeout=4)"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
