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

# A reusable negative prompt that suppresses the artifacts base diffusion models
# are most prone to — mangled hands, extra/fused fingers, broken limbs. The UI
# pre-fills this for guided models so anatomy is cleaner out of the box; it's
# fully editable. Turbo runs with guidance disabled (cfg 0) and ignores the
# negative entirely, so it's left blank there.
ANATOMY_NEGATIVE = (
    "deformed hands, mutated hands, extra fingers, fused fingers, missing fingers, "
    "extra limbs, missing limbs, malformed limbs, extra arms, extra legs, "
    "bad anatomy, disfigured, poorly drawn face, poorly drawn hands, "
    "low quality, blurry, jpeg artifacts, watermark, text, signature"
)

# Available models, shown in the UI switcher. Each entry carries the knobs the
# engine needs to run it within the 16 GB unified-memory budget.
#
#   dtype          float16 | float32 — precision on MPS/CPU (CUDA always fp16).
#                  Both fp16 and bf16 produce black images (NaN latents in the
#                  unet) on this torch/MPS build, so models run fp32 here. That
#                  makes generation ~5x slower than half precision would be;
#                  revisit when MPS half-precision is fixed. CUDA gets fp16.
#   offload        use accelerate model-cpu-offload to fit a large fp32 pipeline
#                  in 16 GB (keeps idle components on CPU). Needed for SDXL.
#   sd_safety_checker  this is an SD1.x pipeline that accepts safety_checker=None
#   scheduler      override the pipeline's default sampler. "dpmpp_2m_karras"
#                  (DPM++ 2M w/ Karras sigmas) gives sharper, more coherent
#                  results than the stock Euler scheduler at the same step count.
#                  Omit for distilled models (Turbo), whose baked-in scheduler
#                  must not be swapped.
#   negative       default negative prompt the UI pre-fills for this model.
#   size           default resolution the UI snaps to when this model is picked
#   steps / cfg    default sampler settings the UI applies for this model.
#                  Turbo is distilled for 1-4 steps with guidance disabled
#                  (cfg 0), so the switcher must set these or output is garbage.
MODELS = [
    {
        "id": "stable-diffusion-v1-5/stable-diffusion-v1-5",
        "label": "SD 1.5",
        "dtype": "float32",
        "sd_safety_checker": True,
        "scheduler": "dpmpp_2m_karras",
        "negative": ANATOMY_NEGATIVE,
        "size": 512,
        "steps": 30,
        "cfg": 7.5,
    },
    {
        "id": "stabilityai/stable-diffusion-xl-base-1.0",
        "label": "SDXL 1.0",
        "dtype": "float32",
        "offload": True,
        "scheduler": "dpmpp_2m_karras",
        "negative": ANATOMY_NEGATIVE,
        "size": 1024,
        "steps": 30,
        "cfg": 7.5,
    },
    {
        # Community fine-tune of SDXL tuned for photorealism with notably cleaner
        # hands and faces than base SDXL. Same architecture/footprint as base, so
        # it loads through the same pipeline and offload path.
        "id": "SG161222/RealVisXL_V4.0",
        "label": "RealVisXL 4.0 (photoreal)",
        "dtype": "float32",
        "offload": True,
        "scheduler": "dpmpp_2m_karras",
        "negative": ANATOMY_NEGATIVE,
        "size": 1024,
        "steps": 30,
        "cfg": 7.0,
    },
    {
        # Distilled SDXL: 4 steps instead of 25. At 512 the fp32 pipeline fits
        # 16 GB resident, so it runs WITHOUT offload (offload's one-time UNet
        # transfer would dominate so few steps). ~6x faster than SDXL base here.
        "id": "stabilityai/sdxl-turbo",
        "label": "SDXL Turbo (fast)",
        "dtype": "float32",
        "size": 512,
        "steps": 4,
        "cfg": 0.0,
    },
]

# Default selection. IMAGEN_MODEL overrides which one loads first.
DEFAULT_MODEL = os.environ.get("IMAGEN_MODEL", MODELS[0]["id"])


def model_config(model_id: str) -> dict:
    """Look up a model's engine settings; unknown ids fall back to SD-style fp32."""
    for m in MODELS:
        if m["id"] == model_id:
            return m
    return {
        "id": model_id,
        "label": model_id,
        "dtype": "float32",
        "size": 512,
        "steps": 30,
        "cfg": 7.5,
    }

# Server
HOST = os.environ.get("IMAGEN_HOST", "127.0.0.1")
PORT = int(os.environ.get("IMAGEN_PORT", "7860"))

DISABLE_SAFETY_CHECKER = os.environ.get("IMAGEN_SAFETY_CHECKER", "off").lower() not in (
    "on",
    "1",
    "true",
)


def safe_output_path(filename: str) -> Path | None:
    """Resolve `filename` to an existing file inside OUTPUTS_DIR, or None if it
    is missing or escapes the directory (path traversal). Callers translate
    None into their own not-found error."""
    path = (OUTPUTS_DIR / filename).resolve()
    if OUTPUTS_DIR.resolve() not in path.parents or not path.exists():
        return None
    return path


def ensure_dirs() -> None:
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    # Keep HF downloads inside our home dir so nothing is re-downloaded.
    os.environ.setdefault("HF_HOME", str(MODELS_DIR))
