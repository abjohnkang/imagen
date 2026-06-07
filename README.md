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
  sensible steps/size, a default negative prompt, and the best sampler for it, so
  you usually don't need to touch the other knobs.
  - **SD 1.5** — fastest and lightest. Good for quick tries.
  - **SDXL 1.0** — Stability's base XL model. High resolution, but "raw" — it can
    miss parts of a prompt and produce anatomy glitches (extra fingers, odd
    limbs). Slowest option; several minutes per image on Apple Silicon.
  - **RealVisXL 4.0 (photoreal)** — a community fine-tune of SDXL tuned for
    photorealism with markedly cleaner hands and faces and better prompt
    adherence than base SDXL. Same speed/size as SDXL — **the recommended default
    for quality.**
  - **SDXL Turbo (fast)** — SDXL-level quality in only 4 steps. The fast option.

  All models except Turbo use the **DPM++ 2M (Karras)** sampler for sharper,
  more coherent results than the stock scheduler. Turbo keeps its built-in
  4-step sampler.

- **Prompt** — describe what you want, in plain words. More detail generally
  helps. Example: `a red lighthouse at dusk, cinematic, highly detailed`. You can
  list a subject, a style, lighting, mood, etc., separated by commas.

- **Negative prompt** — what you want to *avoid*. The model steers away from these
  words. Picking a model pre-fills a sensible anatomy/quality negative (suppressing
  deformed hands, extra fingers, broken limbs, watermarks, etc.) — you can edit or
  clear it. Turbo runs with guidance off, so the negative has no effect there.

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

### Image-to-image (img2img)

Normally each image starts from random noise. **img2img** starts from an
*existing image* instead: the model partially re-noises it and then denoises
guided by your prompt, so the result keeps the source's composition while
shifting toward what you ask for. Use it to refine a generation, restyle it, or
nudge one detail (e.g. change "standing" to "sitting") without redrawing the
whole thing.

**How to start one:** in the gallery, hover an image and click **✎** ("use as
starting image"). That loads the image's settings into the form *and* pins it as
the starting image — a thumbnail and a **Strength** slider appear above the
Generate button. Edit the prompt however you like, then **Generate**.

- **Strength** — how far the result moves from the starting image.
  - **Low (~0.2–0.4):** subtle edit, stays close to the original.
  - **Mid (~0.5–0.6):** balanced — the default.
  - **High (~0.8–1.0):** big change; at 1.0 the starting image is essentially
    ignored (back to text-only).
- Because img2img only denoises the last *strength* fraction of the steps, it's
  also **faster** than a full generation at the same step count.
- The output matches the **Width/Height** in the form — the starting image is
  resized to fit, so you can change the aspect/size while you're at it.
- Click **Use text-only ✕** on the strength panel to drop the starting image and
  go back to a normal from-noise generation.

> Note: SDXL Turbo runs so few steps (4) that at low strength there may be only
> 1–2 actual denoising steps, so very subtle edits have limited effect there —
> the guided models give finer img2img control.

### The gallery

Every image you make is saved and shown at the bottom.

- **Click a thumbnail** to load all of its settings (prompt, seed, model, etc.)
  back into the form — great for making a variation of something you liked.
- **Click ✎** to load its settings *and* use it as the starting image for
  img2img (see above).
- **Hover and click ✕** to delete an image (removes the file too).

### A first-try suggestion

Start with **SD 1.5**, a simple prompt, and the default settings — it's the
quickest way to see a result. For a polished final image, switch to **RealVisXL
4.0**: it's the best quality here and handles hands/anatomy far better than base
SDXL. Once you find a seed you like, lock it and experiment.

## What gets stored, and where

Everything lives under `~/imagen/` (override with `IMAGEN_HOME`):

- `~/imagen/outputs/` — every generated PNG, with its prompt/seed/settings
  embedded in the file (img2img images also record their starting image and
  strength). Kept until you delete it (✕ on the gallery thumbnail).
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