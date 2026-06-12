# CPU-only image for imagen. Docker on macOS has no access to the Mac's Metal
# GPU, so PyTorch runs on CPU here — generation is slow but the whole stack
# (Python, torch, model cache) stays isolated from the host.
FROM python:3.12-slim

# Runtime shared libs that Pillow / torch dlopen.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install CPU-only PyTorch from its dedicated index FIRST, so we don't pull the
# multi-GB CUDA build. The rest of the deps then see torch as already satisfied.
RUN pip install --no-cache-dir "torch>=2.2" --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY web ./web

# All runtime data (model cache, outputs, SQLite db) lives under /data, which
# compose backs with a named volume — nothing is written to the host home dir.
# IMAGEN_HOME drives config.BASE_DIR; the app points HF_HOME at /data/models.
ENV IMAGEN_HOME=/data \
    IMAGEN_HOST=0.0.0.0 \
    IMAGEN_PORT=7860

EXPOSE 7860

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7860"]
