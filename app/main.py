"""FastAPI app: REST endpoints, WebSocket progress, and the web UI."""
from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import config, db
from .engine import engine
from .jobs import manager
from .models import GenerateRequest

app = FastAPI(title="imagen")

# Reject requests whose Host header isn't a loopback name. This blocks DNS
# rebinding: without it, any website you visit could rebind its domain to
# 127.0.0.1:7860 and silently drive this API (read the gallery, generate,
# delete) from your browser. Legit local visits send a loopback Host and pass.
# (IPv6 "[::1]" is intentionally omitted: Starlette strips the host at the
# first ":", so a bracketed IPv6 literal can never match — browsers reach us
# via 127.0.0.1 or localhost anyway.)
app.add_middleware(
    TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"]
)

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


@app.on_event("startup")
def _startup() -> None:
    db.init()


# -- API ------------------------------------------------------------------
@app.post("/api/generate")
def generate(req: GenerateRequest) -> dict:
    job_id = manager.submit(req)
    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = manager.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    return job.to_dict()


@app.websocket("/api/progress/{job_id}")
async def progress(ws: WebSocket, job_id: str) -> None:
    await ws.accept()
    try:
        while True:
            job = manager.get(job_id)
            if job is None:
                await ws.send_json({"status": "error", "error": "job not found"})
                break
            await ws.send_json(job.to_dict())
            if job.status in ("done", "error"):
                break
            await asyncio.sleep(0.2)
    except WebSocketDisconnect:
        pass


@app.get("/api/gallery")
def gallery(limit: int = 60, offset: int = 0) -> list[dict]:
    return db.list_images(limit=limit, offset=offset)


@app.delete("/api/gallery/{image_id}")
def delete_image(image_id: str) -> dict:
    filename = db.delete(image_id)
    if filename is None:
        raise HTTPException(404, "image not found")
    fpath = config.OUTPUTS_DIR / filename
    if fpath.exists():
        fpath.unlink()
    return {"deleted": image_id}


@app.get("/api/models")
def models() -> dict:
    return {
        "default": config.DEFAULT_MODEL,
        "device": engine.device,
        "models": [
            {
                "id": m["id"],
                "label": m["label"],
                "size": m["size"],
                "steps": m["steps"],
                "cfg": m["cfg"],
                "negative": m.get("negative", ""),
            }
            for m in config.MODELS
        ],
    }


@app.get("/api/outputs/{filename}")
def output(filename: str) -> FileResponse:
    # Guard against path traversal.
    fpath = (config.OUTPUTS_DIR / filename).resolve()
    if config.OUTPUTS_DIR.resolve() not in fpath.parents or not fpath.exists():
        raise HTTPException(404, "not found")
    return FileResponse(fpath)


# -- Web UI (mounted last so it doesn't shadow /api) ----------------------
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
