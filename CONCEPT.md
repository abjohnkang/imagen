# imagen — Local AI Image Generator

A self-hosted, fully local image generation app with a web UI. Runs entirely on
your own machine: no API tokens, no per-image cost and no cloud round-trips.
You own the model weights and the box they run on.

## Goals

- **Local-first** — all inference happens on this machine. Nothing leaves the box.
- **Zero marginal cost** — generate as much as you want; the only cost is electricity and time.
- **Web UI** — a clean browser interface served from localhost, usable from any device on your LAN.
- **Reproducible** — every image records its prompt, seed, model, and settings so you can recreate or tweak it.

## Hardware target

This box: **Apple M3 / 16 GB unified memory.**

That's the primary constraint and it drives every choice below:

- No CUDA. Inference runs on Apple's **Metal (MPS)** backend.
- 16 GB unified memory is shared between the OS, the app, and the model. Budget ~10–12 GB for generation.
- This comfortably runs **SD 1.5** and **SDXL** (with attention slicing / VAE tiling). **Flux** and large video models are tight-to-impractical at 16 GB and are out of scope for v1.

## Model strategy

| Model | VRAM-ish footprint | Fit on M3/16GB | Notes |
|-------|-------------------|----------------|-------|
| **SD 1.5** | ~4 GB | Excellent | Fast, huge ecosystem of fine-tunes/LoRAs, 512×512 native |
| **SDXL** | ~8–10 GB | Good (with slicing) | Higher quality, 1024×1024 native, slower; base model is "raw" |
| **RealVisXL 4.0** | ~8–10 GB | Good (with slicing) | SDXL photoreal fine-tune; cleaner anatomy + prompt adherence than base |
| **SDXL Turbo / LCM** | ~8 GB | Good | Few-step (1–4) generation, near-realtime previews |
| Flux.1 | 12–24 GB | Out of scope v1 | Revisit with quantized GGUF later |

Models are downloaded once from Hugging Face into a local cache and run offline
thereafter. Custom checkpoints, LoRAs, and embeddings drop into a watched folder
and appear in the UI.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Browser (Web UI)  —  http://localhost:7860   │
│  prompt box · gallery · settings · queue       │
└───────────────────────┬───────────────────────┘
                        │  HTTP + WebSocket (live progress)
┌───────────────────────▼───────────────────────┐
│  Backend API server  (FastAPI / Python)         │
│  · job queue        · model manager             │
│  · settings store   · metadata DB (SQLite)      │
└───────────────────────┬───────────────────────┘
                        │  in-process calls
┌───────────────────────▼───────────────────────┐
│  Inference engine  (diffusers + PyTorch/MPS)     │
│  · pipeline cache   · scheduler/sampler          │
│  · attention slicing · VAE tiling                │
└───────────────────────┬───────────────────────┘
                        │
┌───────────────────────▼───────────────────────┐
│  Local storage                                   │
│  ~/imagen/models  ~/imagen/outputs  imagen.db    │
└─────────────────────────────────────────────────┘
```

### Components

1. **Web UI** — single-page app served by the backend. Prompt + negative prompt,
   model/LoRA picker, sampler, steps, CFG scale, size, seed, batch count. Live
   progress over WebSocket, a gallery of past generations, click-to-reuse settings.

2. **Backend API** (FastAPI) — REST endpoints + a WebSocket for progress. Owns a
   **single-worker job queue** (one generation at a time; 16 GB can't parallelize
   diffusion safely). Endpoints:
   - `POST /api/generate` — enqueue a job, returns a job id
   - `GET  /api/jobs/{id}` — status / result
   - `WS   /api/progress`  — step-by-step progress + preview latents
   - `GET  /api/models` · `POST /api/models/load`
   - `GET  /api/gallery` — paginated history from SQLite

3. **Inference engine** — Hugging Face `diffusers` on the `mps` device.
   Attention slicing on, VAE tiling for SDXL. Pipelines are loaded lazily and
   cached; switching models evicts the previous one to respect the memory budget.

4. **Storage** — PNG outputs with full generation metadata embedded in the file's
   text chunks, plus a SQLite row per image for fast gallery queries. Models live
   in a local cache dir; nothing is re-downloaded once present.

## Tech stack (proposed)

- **Backend:** Python 3.11+, FastAPI, Uvicorn
- **Inference:** PyTorch (MPS), Hugging Face `diffusers`, `transformers`, `accelerate`
- **DB:** SQLite (via SQLModel or plain `sqlite3`)
- **Frontend:** Vanilla + a light framework — start with plain HTML/JS + HTMX, or React/Vite if the UI grows
- **Packaging:** a `run.sh` / Makefile that sets up a venv, installs deps, downloads a default model, and launches the server

> Alternative if you'd rather not build inference from scratch: stand the UI/queue
> in front of **ComfyUI** or **Automatic1111** (both run on M-series via MPS).
> Building our own thin `diffusers` engine keeps the stack small and fully ours;
> wrapping ComfyUI gets a battle-tested backend faster. **Recommendation for v1:
> thin `diffusers` engine** — fewer moving parts, easier to tailor to 16 GB.

## Feature roadmap

**v1 — MVP**
- Text-to-image with SD 1.5, web UI, live progress, gallery, seed control
- Generation metadata saved to PNG + SQLite

**v2**
- SDXL + Turbo/LCM support, model switcher in UI
- Negative prompts, sampler/scheduler choice, batch generation

**v3**
- LoRA / custom checkpoint loading from a watched folder
- Image-to-image and inpainting
- Upscaling (Real-ESRGAN)

**Later**
- ControlNet, prompt history/favorites, LAN access for other devices, quantized Flux

## Non-goals (v1)

- Cloud deployment or multi-user auth
- Training / fine-tuning models (inference only)
- Video generation
- Running models that don't fit comfortably in 16 GB

## Open questions

- Default model to ship with — SD 1.5 (fast, light) vs. an SDXL fine-tune (heavier, better)?
- Plain HTMX UI vs. a React frontend — how rich does the UI need to get?
- Build our own `diffusers` engine, or wrap ComfyUI as the backend?
- Where to store outputs/models — under the repo, or in `~/imagen/`?
