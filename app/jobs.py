"""Single-worker generation queue.

Diffusion can't be safely parallelized on 16 GB, so exactly one job runs at a
time. Jobs are kept in an in-memory dict; the WebSocket endpoint reads each
job's live state to stream progress to the browser.
"""
from __future__ import annotations

import queue
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from . import db
from .engine import engine


class GenerationCancelled(Exception):
    """Raised from the step callback to abort an in-flight generation."""


@dataclass
class Job:
    id: str
    params: Any
    status: str = "queued"  # queued | running | done | error | cancelled
    cancel_requested: bool = False
    step: int = 0
    total: int = 0
    filename: str | None = None
    seed: int | None = None
    error: str | None = None
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "step": self.step,
            "total": self.total,
            "filename": self.filename,
            "seed": self.seed,
            "error": self.error,
        }


class JobManager:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._queue: "queue.Queue[str]" = queue.Queue()
        self._lock = threading.Lock()
        self._worker = threading.Thread(target=self._loop, daemon=True)
        self._worker.start()

    def submit(self, params) -> str:
        job = Job(id=uuid.uuid4().hex, params=params)
        with self._lock:
            self._jobs[job.id] = job
        self._queue.put(job.id)
        return job.id

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> bool:
        """Request cancellation. Returns False if the job is unknown or already
        finished; otherwise flags it so the worker stops at the next step.

        A job that hasn't started yet is also marked "cancelled" right here, so
        the UI reflects it immediately instead of waiting for the worker to drain
        everything ahead of it. The worker still skips any job whose cancel was
        requested when it dequeues, so this is safe against the in-flight case."""
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or job.status in ("done", "error", "cancelled"):
                return False
            job.cancel_requested = True
            if job.status == "queued":
                job.status = "cancelled"
            return True

    def _loop(self) -> None:
        while True:
            job_id = self._queue.get()
            job = self.get(job_id)
            if job is None:
                continue
            # Cancelled while still queued — never start it.
            if job.cancel_requested:
                job.status = "cancelled"
                self._queue.task_done()
                continue
            job.status = "running"
            try:
                def on_step(step: int, total: int) -> None:
                    # Abort between steps if a cancel came in. Raising here
                    # unwinds out of the pipeline so no partial image is saved.
                    if job.cancel_requested:
                        raise GenerationCancelled
                    job.step = step
                    job.total = total

                filename, seed = engine.generate(job.params, on_step=on_step)
                job.filename = filename
                job.seed = seed
                job.status = "done"
                self._record(job)
            except GenerationCancelled:
                job.status = "cancelled"
            except Exception as exc:  # noqa: BLE001 - surface any failure to the UI
                job.status = "error"
                job.error = str(exc)
            finally:
                self._queue.task_done()

    def _record(self, job: Job) -> None:
        p = job.params
        db.insert(
            {
                "id": job.id,
                "filename": job.filename,
                "prompt": p.prompt,
                "negative": p.negative,
                "seed": job.seed,
                "steps": p.steps,
                "cfg": p.cfg,
                "width": p.width,
                "height": p.height,
                "model": p.model,
                "created_at": job.created_at,
                "init_image": p.init_image or None,
                "strength": p.strength if p.init_image else None,
            }
        )


manager = JobManager()
