"""Request/response schemas."""
from __future__ import annotations

from pydantic import BaseModel, Field

from . import config


class GenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    negative: str = ""
    steps: int = Field(30, ge=1, le=150)
    cfg: float = Field(7.5, ge=0, le=30)
    width: int = Field(512, ge=128, le=1536)
    height: int = Field(512, ge=128, le=1536)
    seed: int = -1  # -1 means random
    model: str = config.DEFAULT_MODEL

    # img2img: when set, generation starts from this existing output image
    # (a filename in OUTPUTS_DIR) instead of pure noise. `strength` is how far
    # to move away from it — 0.0 keeps the original, 1.0 ignores it entirely.
    init_image: str = ""
    strength: float = Field(0.6, ge=0.0, le=1.0)
