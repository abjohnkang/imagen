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

# Available models, shown in the UI switcher. Each entry carries the knobs the
# engine needs to run it within the 16 GB unified-memory budget.
#
#   dtype          float16 | float32 — precision on MPS/CPU (CUDA always fp16).
#                  fp16 produces black images (NaNs) on this MPS build, so models
#                  run fp32 here; CUDA boxes get fp16 automatically.
#   offload        use accelerate model-cpu-offload to fit a large fp32 pipeline
#                  in 16 GB (keeps idle components on CPU). Needed for SDXL.
#   sd_safety_checker  this is an SD1.x pipeline that accepts safety_checker=None
#   size           sensible default resolution for the UI when this model is picked
MODELS = [
    {
        "id": "stable-diffusion-v1-5/stable-diffusion-v1-5",
        "label": "SD 1.5",
        "dtype": "float32",
        "sd_safety_checker": True,
        "size": 512,
    },
    {
        "id": "stabilityai/stable-diffusion-xl-base-1.0",
        "label": "SDXL 1.0",
        "dtype": "float32",
        "offload": True,
        "size": 1024,
    },
]

# Default selection. IMAGEN_MODEL overrides which one loads first.
DEFAULT_MODEL = os.environ.get("IMAGEN_MODEL", MODELS[0]["id"])


def model_config(model_id: str) -> dict:
    """Look up a model's engine settings; unknown ids fall back to SD-style fp32."""
    for m in MODELS:
        if m["id"] == model_id:
            return m
    return {"id": model_id, "label": model_id, "dtype": "float32", "size": 512}

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
