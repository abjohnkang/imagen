# Imagen

A local AI image generator with a web UI. Runs entirely on your own
machine — no API tokens, no per-image cost, no cloud. Built for Apple Silicon
(M-series / MPS).

## Quick start

```bash
./run.sh
```

First run creates a virtualenv and installs PyTorch + diffusers (this takes a
while and downloads a few GB). Then open **http://127.0.0.1:7860**.

The first *generation* also downloads the default model (~4 GB for SD 1.5) into
`~/imagen/models`, so the first image is slow; subsequent ones are fast and fully
offline.

## How to use it

Open **http://127.0.0.1:7860** and you'll see a form on the left, a preview on
the right, and a gallery of past images below.

**The basic loop:** pick a model → type a prompt → click **Generate**. A progress
bar fills as it works (one image at a time), and the result appears in the
preview and gets added to the gallery. That's it — everything else is optional
tuning.

### The controls

- **Model** — which AI model generates the image. Picking one automatically sets
  sensible steps/size for it, so you usually don't need to touch the other knobs.
  - **SD 1.5** — fastest and lightest. Good for quick tries.
  - **SDXL 1.0** — highest quality, but the slowest; generation time scales with
    your hardware (can be several minutes per image on Apple Silicon).
  - **SDXL Turbo (fast)** — SDXL-level quality in only 4 steps. The fast option.

- **Prompt** — describe what you want, in plain words. More detail generally
  helps. Example: `a red lighthouse at dusk, cinematic, highly detailed`. You can
  list a subject, a style, lighting, mood, etc., separated by commas.

- **Negative prompt** — what you want to *avoid*. The model steers away from these
  words. Common ones: `blurry, low quality, extra fingers, watermark, text`.
  Leave it blank if you don't care.

- **Steps** — how many refinement passes the model makes. Each step takes the
  image from noise toward your prompt.
  - More steps = more detail/coherence, but slower. Fewer = faster, rougher.
  - Typical: ~25–30 for SD 1.5 / SDXL. **SDXL Turbo only needs 4** (it's built
    that way — don't crank it up, it won't help).

- **CFG** (guidance scale) — how strictly the model follows your prompt.
  - Low (~3–6): looser, more creative, can drift from the prompt.
  - Medium (~7–8): balanced. A good default.
  - High (~12+): clings tightly to the prompt, but can look over-cooked/harsh.
  - **SDXL Turbo uses 0** (guidance off) by design — the switcher sets this for you.

- **Width / Height** — output size in pixels. Each model has a "native" size it
  was trained on and looks best at: **512×512 for SD 1.5 and Turbo, 1024×1024 for
  SDXL**. Bigger images take more time and memory; straying far from the native
  size can produce odd results (e.g. duplicated subjects).

- **Seed** — the starting random number. This is what makes results
  *reproducible*.
  - **`-1` means random** — you get a different image every time.
  - Set a specific number (e.g. `42`) and the **same prompt + same settings + same
    seed always produces the exact same image**. After a generation, the seed used
    is filled in for you.
  - Workflow tip: generate with seed `-1` until you get something you like, then
    *lock that seed* and tweak the prompt/steps to refine the same composition.

### The gallery

Every image you make is saved and shown at the bottom.

- **Click a thumbnail** to load all of its settings (prompt, seed, model, etc.)
  back into the form — great for making a variation of something you liked.
- **Hover and click ✕** to delete an image (removes the file too).

### A first-try suggestion

Start with **SD 1.5**, a simple prompt, and the default settings — it's the
quickest way to see a result. Then try the same prompt on **SDXL Turbo** to
compare quality. Once you find a seed you like, lock it and experiment.

## What gets stored, and where

Everything lives under `~/imagen/` (override with `IMAGEN_HOME`):

- `~/imagen/outputs/` — every generated PNG, with its prompt/seed/settings
  embedded in the file. Kept until you delete it (✕ on the gallery thumbnail).
- `~/imagen/imagen.db` — SQLite index that powers the gallery.
- `~/imagen/models/` — downloaded model weights (cached, never re-downloaded).

## Configuration

All optional, via environment variables:

| Variable | Default | Meaning |
|----------|---------|---------|
| `IMAGEN_HOME` | `~/imagen` | Where outputs, db, and models live |
| `IMAGEN_MODEL` | `stable-diffusion-v1-5/stable-diffusion-v1-5` | Default HF model |
| `IMAGEN_HOST` | `127.0.0.1` | Bind address (set to `0.0.0.0` for LAN access) |
| `IMAGEN_PORT` | `7860` | Port |

## Layout

```
app/
  main.py     FastAPI routes + WebSocket progress + serves the web UI
  engine.py   diffusers inference on MPS (memory-tuned for 16 GB)
  jobs.py     single-worker generation queue
  db.py       SQLite gallery index
  config.py   paths + env config
  models.py   request schema
web/
  index.html · app.js · style.css   no-build web UI
```