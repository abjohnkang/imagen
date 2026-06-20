"""FastAPI app: REST endpoints, WebSocket progress, and the web UI."""
from __future__ import annotations

import asyncio
import io
import zipfile
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
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


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    if not manager.cancel(job_id):
        raise HTTPException(404, "job not found or already finished")
    return {"cancelling": job_id}


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
            if job.status in ("done", "error", "cancelled"):
                break
            await asyncio.sleep(0.2)
    except WebSocketDisconnect:
        pass


@app.get("/api/gallery")
def gallery(limit: int = 60, offset: int = 0, favorites: bool = False) -> list[dict]:
    return db.list_images(limit=limit, offset=offset, favorites_only=favorites)


@app.get("/api/gallery/count")
def gallery_count(favorites: bool = False) -> dict:
    """Total image count, so the UI can compute how many pages there are."""
    return {"count": db.count(favorites_only=favorites)}


@app.post("/api/gallery/{image_id}/favorite")
def set_favorite(image_id: str, favorite: bool = Body(..., embed=True)) -> dict:
    if not db.set_favorite(image_id, favorite):
        raise HTTPException(404, "image not found")
    return {"id": image_id, "favorite": favorite}


def _delete_image(image_id: str) -> bool:
    """Remove one image (file then row). Returns False if the id is unknown.

    Delete the file before the row: if the unlink fails, the gallery entry
    survives so the image stays visible and the delete is retryable — rather
    than dropping the row and orphaning the file on disk with no way to reach
    it from the UI.
    """
    filename = db.peek(image_id)
    if filename is None:
        return False
    fpath = config.OUTPUTS_DIR / filename
    if fpath.exists():
        fpath.unlink()
    db.delete(image_id)
    return True


@app.delete("/api/gallery/{image_id}")
def delete_image(image_id: str) -> dict:
    if not _delete_image(image_id):
        raise HTTPException(404, "image not found")
    return {"deleted": image_id}


@app.post("/api/gallery/delete")
def delete_images(ids: list[str] = Body(..., embed=True)) -> dict:
    """Delete several images at once; unknown ids are skipped, not an error."""
    deleted = [i for i in ids if _delete_image(i)]
    return {"deleted": deleted}


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


@app.post("/api/download")
def download_zip(filenames: list[str] = Body(..., embed=True)) -> Response:
    """Bundle the requested output images into a single zip for download. Each
    name is validated through safe_output_path, so unknown or traversing names
    are silently skipped rather than trusted."""
    buf = io.BytesIO()
    added = 0
    # PNGs are already compressed, so store (don't re-deflate) to stay fast.
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        for name in filenames:
            path = config.safe_output_path(name)
            if path is None:
                continue
            zf.write(path, arcname=path.name)
            added += 1
    if added == 0:
        raise HTTPException(404, "no valid images to download")
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="imagen-images.zip"'},
    )


@app.get("/api/outputs/{filename}")
def output(filename: str) -> FileResponse:
    fpath = config.safe_output_path(filename)  # guards against path traversal
    if fpath is None:
        raise HTTPException(404, "not found")
    return FileResponse(fpath)


# -- Web UI (mounted last so it doesn't shadow /api) ----------------------
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
