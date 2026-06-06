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
    _conn.commit()


def insert(row: dict[str, Any]) -> None:
    with _lock:
        _conn.execute(
            """
            INSERT INTO images
                (id, filename, prompt, negative, seed, steps, cfg,
                 width, height, model, created_at)
            VALUES
                (:id, :filename, :prompt, :negative, :seed, :steps, :cfg,
                 :width, :height, :model, :created_at)
            """,
            row,
        )
        _conn.commit()


def list_images(limit: int = 60, offset: int = 0) -> list[dict[str, Any]]:
    with _lock:
        cur = _conn.execute(
            "SELECT * FROM images ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (limit, offset),
        )
        return [dict(r) for r in cur.fetchall()]


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
