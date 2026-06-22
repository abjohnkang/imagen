"""SQLite-backed gallery index. One row per generated image.

The image PNGs are the source of truth (settings are embedded in the file);
this table just makes the gallery fast to list and search.
"""
from __future__ import annotations

import sqlite3
import threading
from typing import Any

from . import config

_lock = threading.Lock()


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


_conn = None


def init() -> None:
    global _conn
    config.ensure_dirs()
    _conn = _connect()
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS images (
            id         TEXT PRIMARY KEY,
            filename   TEXT NOT NULL,
            prompt     TEXT NOT NULL,
            negative   TEXT,
            seed       INTEGER,
            steps      INTEGER,
            cfg        REAL,
            width      INTEGER,
            height     INTEGER,
            model      TEXT,
            created_at TEXT NOT NULL
        )
        """
    )
    # Migrate older galleries: add img2img columns if they're missing.
    cols = {r["name"] for r in _conn.execute("PRAGMA table_info(images)")}
    if "init_image" not in cols:
        _conn.execute("ALTER TABLE images ADD COLUMN init_image TEXT")
    if "strength" not in cols:
        _conn.execute("ALTER TABLE images ADD COLUMN strength REAL")
    if "favorite" not in cols:
        _conn.execute("ALTER TABLE images ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0")
    _conn.commit()


def insert(row: dict[str, Any]) -> None:
    with _lock:
        _conn.execute(
            """
            INSERT INTO images
                (id, filename, prompt, negative, seed, steps, cfg,
                 width, height, model, created_at, init_image, strength)
            VALUES
                (:id, :filename, :prompt, :negative, :seed, :steps, :cfg,
                 :width, :height, :model, :created_at, :init_image, :strength)
            """,
            row,
        )
        _conn.commit()


def _where(favorites_only: bool, query: str) -> tuple[str, list[Any]]:
    """Build the shared WHERE clause (and params) for the gallery filters.

    Conditions are AND-ed. `query` is a case-insensitive substring match on the
    prompt; %, _ and \\ are escaped so they match literally rather than acting
    as LIKE wildcards.
    """
    conds: list[str] = []
    params: list[Any] = []
    if favorites_only:
        conds.append("favorite = 1")
    if query:
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        conds.append("prompt LIKE ? ESCAPE '\\'")
        params.append(f"%{escaped}%")
    clause = (" WHERE " + " AND ".join(conds)) if conds else ""
    return clause, params


def count(favorites_only: bool = False, query: str = "") -> int:
    """Total number of images in the gallery (for pagination)."""
    with _lock:
        clause, params = _where(favorites_only, query)
        cur = _conn.execute("SELECT COUNT(*) AS n FROM images" + clause, params)
        return cur.fetchone()["n"]


def list_images(
    limit: int = 60, offset: int = 0, favorites_only: bool = False, query: str = ""
) -> list[dict[str, Any]]:
    with _lock:
        clause, params = _where(favorites_only, query)
        sql = "SELECT * FROM images" + clause + " ORDER BY created_at DESC LIMIT ? OFFSET ?"
        cur = _conn.execute(sql, [*params, limit, offset])
        return [dict(r) for r in cur.fetchall()]


def set_favorite(image_id: str, value: bool) -> bool:
    """Flag/unflag an image as a favorite. Returns False if the id is unknown."""
    with _lock:
        cur = _conn.execute(
            "UPDATE images SET favorite = ? WHERE id = ?",
            (1 if value else 0, image_id),
        )
        _conn.commit()
        return cur.rowcount > 0


def peek(image_id: str) -> str | None:
    """Return a row's filename without deleting it, or None if it doesn't exist."""
    with _lock:
        cur = _conn.execute("SELECT filename FROM images WHERE id = ?", (image_id,))
        row = cur.fetchone()
        return row["filename"] if row is not None else None


def delete(image_id: str) -> str | None:
    """Remove a row; returns the filename so the caller can unlink the file."""
    with _lock:
        cur = _conn.execute("SELECT filename FROM images WHERE id = ?", (image_id,))
        row = cur.fetchone()
        if row is None:
            return None
        _conn.execute("DELETE FROM images WHERE id = ?", (image_id,))
        _conn.commit()
        return row["filename"]
