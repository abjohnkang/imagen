"""Runtime configuration. Override anything via environment variables."""
from __future__ import annotations

import os
from pathlib import Path

# Where generated images, the SQLite DB, and the model cache live.
# Defaults to ~/imagen so generations are never tangled up with the source tree.
BASE_DIR = Path(os.environ.get("IMAGEN_HOME", Path.home() / "imagen")).expanduser()
OUTPUTS_DIR = BASE_DIR / "outputs"
MODELS_DIR = BASE_DIR / "models"
DB_PATH = BASE_DIR / "imagen.db"

# Default model. SD 1.5 — fast, light, fits comfortably in 16 GB.
DEFAULT_MODEL = os.environ.get(
    "IMAGEN_MODEL", "stable-diffusion-v1-5/stable-diffusion-v1-5"
)

# Server
HOST = os.environ.get("IMAGEN_HOST", "127.0.0.1")
PORT = int(os.environ.get("IMAGEN_PORT", "7860"))

DISABLE_SAFETY_CHECKER = os.environ.get("IMAGEN_SAFETY_CHECKER", "off").lower() not in (
    "on",
    "1",
    "true",
)


def ensure_dirs() -> None:
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    # Keep HF downloads inside our home dir so nothing is re-downloaded.
    os.environ.setdefault("HF_HOME", str(MODELS_DIR))
