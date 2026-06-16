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

This box is an **Apple M3 / 16 GB unified memory**, but the app ships in
**Docker**, and Docker on macOS has **no GPU passthrough** — no Metal (MPS), no
CUDA. So inference runs **CPU-only**, and that's the constraint that drives the
choices below:

- **CPU-bound.** Generation runs on the container's CPU cores. It works, but
  it's slow — minutes per image for SD 1.5, considerably more for the
  SDXL-class models. The M3 GPU sits idle; using it would mean running natively
  outside Docker, which is out of scope.
- **The memory ceiling is the Docker VM, not the host.** Docker Desktop hands
  the Linux VM a slice of the 16 GB (≈8 GB by default). SD 1.5 (~4 GB fp32) fits
  comfortably; the SDXL-class pipelines (~14 GB fp32) exceed it and lean on the
  VM's swap, so they still run, just slower. Raising Docker's memory allocation
  helps the big models.
- This runs **SD 1.5**, **SDXL**, **RealVisXL**, and **SDXL Turbo** (with
  attention slicing / VAE tiling always on). **Flux** and large video models are
  out of scope for v1.

## Model strategy

Everything runs in **fp32** (CPU has no use for half precision), so footprints
below are the fp32 resident weights.

| Model | fp32 footprint | On CPU (Docker) | Notes |
|-------|----------------|-----------------|-------|
| **SD 1.5** | ~4 GB | Fits the default ~8 GB VM; fastest | Huge ecosystem of fine-tunes/LoRAs, 512×512 native |
| **SDXL** | ~14 GB | Runs (swaps past the ~8 GB VM), slow | Higher quality, 1024×1024 native; base model is "raw" |
| **RealVisXL 4.0** | ~14 GB | Runs (swaps), slow | SDXL photoreal fine-tune; cleaner anatomy + prompt adherence than base |
| **SDXL Turbo** | ~14 GB | Runs; few steps make it the quickest SDXL-class | 1–4 step generation, 512 native |
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
│  Inference engine  (diffusers + PyTorch, CPU)    │
│  · pipeline cache   · scheduler/sampler          │
│  · attention slicing · VAE tiling                │
└───────────────────────┬───────────────────────┘
                        │
┌───────────────────────▼───────────────────────┐
│  Local storage  (Docker volume, mounted at /data)│
│  /data/models  /data/outputs  /data/imagen.db    │
└─────────────────────────────────────────────────┘
```

### Components

1. **Web UI** — single-page app served by the backend. Prompt + negative prompt,
   model/LoRA picker, sampler, steps, CFG scale, size, seed, batch count. Live
   progress over WebSocket, a gallery of past generations, click-to-reuse settings.

2. **Backend API** (FastAPI) — REST endpoints + a WebSocket for progress. Owns a
   **single-worker job queue** (one generation at a time; CPU diffusion can't be
   parallelized usefully). Endpoints:
   - `POST /api/generate` — enqueue a job, returns a job id
   - `GET  /api/jobs/{id}` — status / result
   - `WS   /api/progress`  — step-by-step progress + preview latents
   - `GET  /api/models` · `POST /api/models/load`
   - `GET  /api/gallery` — paginated history from SQLite

3. **Inference engine** — Hugging Face `diffusers` running on CPU. Attention
   slicing on, VAE tiling for SDXL. Pipelines are loaded lazily and cached;
   switching models evicts the previous one so only one stays resident.

4. **Storage** — PNG outputs with full generation metadata embedded in the file's
   text chunks, plus a SQLite row per image for fast gallery queries. Models live
   in a local cache dir; nothing is re-downloaded once present.

## Tech stack (proposed)

- **Backend:** Python 3.11+, FastAPI, Uvicorn
- **Inference:** PyTorch (CPU build), Hugging Face `diffusers`, `transformers`, `accelerate`
- **DB:** SQLite (via SQLModel or plain `sqlite3`)
- **Frontend:** Vanilla + a light framework — start with plain HTML/JS + HTMX, or React/Vite if the UI grows
- **Packaging:** Docker + docker-compose — the whole stack (Python, CPU PyTorch, diffusers, model cache) runs in a container; `run.sh` builds and launches it

> Alternative if you'd rather not build inference from scratch: stand the UI/queue
> in front of **ComfyUI** or **Automatic1111**. Building our own thin `diffusers`
> engine keeps the stack small and fully ours; wrapping ComfyUI gets a
> battle-tested backend faster. **Recommendation for v1: thin `diffusers` engine**
> — fewer moving parts.

## Feature roadmap

**v1 — MVP**
- Text-to-image with SD 1.5, web UI, live progress, gallery, seed control
- Generation metadata saved to PNG + SQLite

**v2**
- SDXL + Turbo/LCM support, model switcher in UI
- Negative prompts, sampler/scheduler choice, batch generation
- Image-to-image (generate from an existing output, strength control)

**v3**
- LoRA / custom checkpoint loading from a watched folder
- Inpainting
- Upscaling (Real-ESRGAN)

**Later**
- ControlNet, prompt history/favorites, LAN access for other devices, quantized Flux

## Non-goals (v1)

- Cloud deployment or multi-user auth
- Training / fine-tuning models (inference only)
- Video generation
- Running models too heavy to be practical on CPU (e.g. Flux)
- GPU acceleration (Docker on macOS can't reach the Metal GPU)

## Open questions

- Default model to ship with — SD 1.5 (fast, light) vs. an SDXL fine-tune (heavier, better)?
- Plain HTMX UI vs. a React frontend — how rich does the UI need to get?
- Build our own `diffusers` engine, or wrap ComfyUI as the backend?
- Where to store outputs/models — under the repo, or in `~/imagen/`?
