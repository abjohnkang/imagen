"""Diffusers inference engine for Apple Silicon (MPS).

Pipelines are loaded lazily and cached. Switching models evicts the previous
pipeline to respect the 16 GB unified-memory budget.

Heavy imports (torch/diffusers) are done lazily so the web server can boot even
before the ML dependencies finish installing.
"""
from __future__ import annotations

import inspect
import os
from datetime import datetime, timezone
from typing import Callable

from . import config


class Engine:
    def __init__(self) -> None:
        self._pipe = None
        self._loaded_model: str | None = None
        # img2img pipeline, derived from self._pipe via from_pipe (shares the
        # same weights, so it costs no extra memory). Cached per loaded model.
        self._i2i_pipe = None
        self._i2i_model: str | None = None
        self._torch = None
        self._device = None

    # -- lazy setup -------------------------------------------------------
    def _ensure_torch(self):
        if self._torch is None:
            import torch

            self._torch = torch
            if torch.backends.mps.is_available():
                self._device = "mps"
            elif torch.cuda.is_available():
                self._device = "cuda"
            else:
                self._device = "cpu"
        return self._torch

    @property
    def device(self) -> str:
        self._ensure_torch()
        return self._device

    def load(self, model: str):
        """Load (and cache) a pipeline for `model`, evicting any other model."""
        if self._pipe is not None and self._loaded_model == model:
            return self._pipe

        torch = self._ensure_torch()
        from diffusers import AutoPipelineForText2Image

        # Free the previously loaded pipeline first.
        if self._pipe is not None:
            del self._pipe
            self._pipe = None
            # The img2img pipe shared the evicted weights — drop it too.
            self._i2i_pipe = None
            self._i2i_model = None
            if self._device == "mps":
                torch.mps.empty_cache()
            elif self._device == "cuda":
                torch.cuda.empty_cache()

        mcfg = config.model_config(model)

        # Precision. CUDA is always fp16. On MPS, fp16 produces black images
        # (NaNs in the unet) on this torch build, so models run in fp32. Larger
        # fp32 pipelines (SDXL) use cpu-offload below to fit the memory budget.
        dtype = torch.float16 if self._device == "cuda" else torch.float32
        if self._device != "cuda" and mcfg.get("dtype") == "float16":
            dtype = torch.float16  # explicit opt-in (e.g. when fp16 is known-good)

        kwargs = {"torch_dtype": dtype}
        # safety_checker is an SD1.x-only pipeline arg; SDXL doesn't accept it.
        if config.DISABLE_SAFETY_CHECKER and mcfg.get("sd_safety_checker"):
            kwargs["safety_checker"] = None
            kwargs["requires_safety_checker"] = False

        pipe = AutoPipelineForText2Image.from_pretrained(model, **kwargs)

        # Swap in a stronger sampler when the model asks for one. DPM++ 2M with
        # Karras sigmas converges to cleaner, more coherent images than the
        # stock Euler scheduler at the same step count. Distilled models (Turbo)
        # carry no scheduler key and keep their baked-in sampler.
        if mcfg.get("scheduler") == "dpmpp_2m_karras":
            from diffusers import DPMSolverMultistepScheduler

            pipe.scheduler = DPMSolverMultistepScheduler.from_config(
                pipe.scheduler.config,
                use_karras_sigmas=True,
                algorithm_type="dpmsolver++",
            )

        # Keep memory in check on 16 GB unified memory.
        pipe.enable_attention_slicing()
        if hasattr(pipe, "enable_vae_tiling"):
            pipe.enable_vae_tiling()

        if mcfg.get("offload") and self._device != "cpu":
            # Stream components on/off the GPU so a big fp32 pipeline fits 16 GB.
            pipe.enable_model_cpu_offload(device=self._device)
        else:
            pipe = pipe.to(self._device)

        self._pipe = pipe
        self._loaded_model = model
        return pipe

    def _img2img(self, model: str):
        """Return an image-to-image pipeline reusing `model`'s loaded weights."""
        base = self.load(model)
        if self._i2i_pipe is not None and self._i2i_model == model:
            return self._i2i_pipe

        from diffusers import AutoPipelineForImage2Image

        # from_pipe shares the base pipeline's components (and its cpu-offload
        # hooks), so no weights are reloaded and the memory budget is unchanged.
        i2i = AutoPipelineForImage2Image.from_pipe(base)
        i2i.enable_attention_slicing()
        if hasattr(i2i, "enable_vae_tiling"):
            i2i.enable_vae_tiling()

        self._i2i_pipe = i2i
        self._i2i_model = model
        return i2i

    def _load_init_image(self, filename: str, width: int, height: int):
        """Load an existing output PNG as an init image, resized to the target."""
        from PIL import Image

        # Only files inside OUTPUTS_DIR are valid init images (no traversal).
        path = config.safe_output_path(filename)
        if path is None:
            raise ValueError(f"init image not found: {filename}")
        return Image.open(path).convert("RGB").resize((width, height))

    # -- generation -------------------------------------------------------
    def generate(self, params, on_step: Callable[[int, int], None] | None = None):
        """Run one text-to-image (or image-to-image) job. Returns (filename, seed)."""
        torch = self._ensure_torch()
        init_name = getattr(params, "init_image", "") or ""
        pipe = self._img2img(params.model) if init_name else self.load(params.model)

        seed = params.seed
        if seed is None or seed < 0:
            seed = int.from_bytes(os.urandom(4), "big")
        # CPU generator is the reproducible choice on MPS.
        generator = torch.Generator("cpu").manual_seed(seed)

        call_kwargs = dict(
            prompt=params.prompt,
            negative_prompt=params.negative or None,
            num_inference_steps=params.steps,
            guidance_scale=params.cfg,
            generator=generator,
        )

        if init_name:
            # img2img output size follows the init image, so we resize it to the
            # requested dimensions rather than passing width/height to the pipe.
            call_kwargs["image"] = self._load_init_image(
                init_name, params.width, params.height
            )
            call_kwargs["strength"] = params.strength
            # img2img only denoises the last `strength` fraction of the schedule,
            # so the real step count (and the progress bar's total) is smaller.
            total = max(1, int(params.steps * params.strength))
        else:
            call_kwargs["width"] = params.width
            call_kwargs["height"] = params.height
            total = params.steps

        # Wire up step progress across diffusers API versions.
        sig = inspect.signature(pipe.__call__)
        if on_step is not None:
            if "callback_on_step_end" in sig.parameters:
                def _cb(_pipe, step, _t, kw):
                    on_step(step + 1, total)
                    return kw

                call_kwargs["callback_on_step_end"] = _cb
            elif "callback" in sig.parameters:
                def _legacy(step, _t, _latents):
                    on_step(step + 1, total)

                call_kwargs["callback"] = _legacy
                call_kwargs["callback_steps"] = 1

        result = pipe(**call_kwargs)
        image = result.images[0]

        filename = self._save(image, params, seed)
        return filename, seed

    def _save(self, image, params, seed: int) -> str:
        from PIL import PngImagePlugin

        config.ensure_dirs()
        ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        filename = f"{ts}-{seed}.png"
        path = config.OUTPUTS_DIR / filename

        # Embed the full recipe inside the PNG so the image is self-describing.
        meta = PngImagePlugin.PngInfo()
        meta.add_text("prompt", params.prompt)
        meta.add_text("negative", params.negative or "")
        meta.add_text("seed", str(seed))
        meta.add_text("steps", str(params.steps))
        meta.add_text("cfg", str(params.cfg))
        meta.add_text("size", f"{params.width}x{params.height}")
        meta.add_text("model", params.model)
        if getattr(params, "init_image", ""):
            meta.add_text("init_image", params.init_image)
            meta.add_text("strength", str(params.strength))
        image.save(path, pnginfo=meta)
        return filename


engine = Engine()
