# Imagen

A local AI image generator with a web UI. Runs entirely on your own machine —
no API tokens, no per-image cost, no cloud. The whole stack (Python, PyTorch,
diffusers, and the downloaded model weights) lives inside Docker, so nothing is
installed on the host.

> **Speed note:** Docker on macOS has no access to the Mac's Metal GPU, so
> generation runs **CPU-only and is slow** — expect minutes per image for SD 1.5
> and considerably more for the SDXL-class models (SDXL, RealVisXL). SDXL Turbo
> (4 steps) is the quickest option.

## Quick start

```bash
./run.sh
```

That's the whole setup. `run.sh` will:

- start **Docker Desktop** for you if it isn't already running (and wait for it),
- build the image on first run — this installs CPU PyTorch + diffusers and
  downloads a few GB, so the first build takes a while,
- start the server in the foreground.

Then open **http://127.0.0.1:7860**.

The first *generation* also downloads the selected model (~4 GB for SD 1.5, more
for SDXL) into the Docker volume, so the first image is slow; the weights are
cached and reused after that, fully offline.

**Stopping / cleaning up** (these pass straight through to `docker compose`):

```bash
./run.sh down        # stop the server
./run.sh down -v     # stop AND wipe the volume (outputs, db, and all models)
```

## How to use it

Open **http://127.0.0.1:7860** and you'll see a form on the left, a preview on
the right, and a gallery of past images below. The header shows the active
compute device (`device: cpu` under Docker).

**The basic loop:** pick a model → type a prompt → click **Generate**. The job is
queued, a progress bar fills as it runs, and the result appears in the preview
and is added to the gallery. You can submit several prompts in a row — they line
up in a small **queue** under the form and run one at a time (CPU diffusion
can't be parallelized usefully). Each queued or running job has a **Cancel**
button; finished images drop off the list automatically.

Everything else is optional tuning.

### The controls

- **Model** — which AI model generates the image. Picking one automatically sets
  sensible steps/size, a default negative prompt, and the best sampler for it, so
  you usually don't need to touch the other knobs.
  - **SD 1.5** — fastest and lightest. Good for quick tries.
  - **SDXL 1.0** — Stability's base XL model. High resolution, but "raw" — it can
    miss parts of a prompt and produce anatomy glitches (extra fingers, odd
    limbs). The slowest option.
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

### The preview

The big image on the right is the last generation (or whichever gallery image
you've opened). Hover it and click **⤓ Save image** to write that single PNG to a
location of your choice (on Chromium-based browsers you get a save dialog;
elsewhere it downloads to your default folder).

### The gallery

Every image you make is saved and shown at the bottom, newest first.

- **Click a thumbnail** to open it in the preview and load all of its settings
  (prompt, seed, model, etc.) back into the form — great for making a variation.
- **Click ✎** to load its settings *and* use it as the starting image for
  img2img (see above).
- **Hover and click ✕** to delete an image (removes the file too).
- **Arrow keys** browse the gallery: ←/→ step one image, ↑/↓ move a whole row.
  (Works when you're not typing in a field.)

**Paging.** The gallery shows 8 rows per page (the column count follows your
window width). Use **← Newer** / **Older →** at the bottom to move between pages;
a new generation jumps you back to the newest page.

**Selecting multiple images** (for bulk download or delete):

- Click the **checkbox** in a thumbnail's corner to tick it. **Shift+Click**
  ticks the whole range between your last pick and this one; **Shift+Arrow** does
  the same from the keyboard.
- **Select all** ticks every photo on the current page (it flips to **Select
  none**); **Clear** drops the entire selection across all pages.
- Selections survive paging — tick some on page 1, more on page 3, then act on
  all of them at once.
- **⤓ Download selected** saves the ticked images. By default each PNG is saved
  separately (pick a folder once on Chromium, or one download per file elsewhere);
  tick **as .zip** to get a single bundle instead.
- **🗑 Delete selected** removes all ticked images at once (with a confirmation —
  this can't be undone).

### A first-try suggestion

Start with **SD 1.5**, a simple prompt, and the default settings — it's the
quickest way to see a result. For a polished final image, switch to **RealVisXL
4.0**: it's the best quality here and handles hands/anatomy far better than base
SDXL. Once you find a seed you like, lock it and experiment.

## What gets stored, and where

All runtime data lives in the **`imagen-data` Docker volume** (mounted at `/data`
inside the container), so nothing is written to your host home directory:

- `/data/outputs/` — every generated PNG, with its prompt/seed/settings embedded
  in the file (img2img images also record their starting image and strength).
  Kept until you delete it (✕ on a thumbnail, or **Delete selected**).
- `/data/imagen.db` — SQLite index that powers the gallery.
- `/data/models/` — downloaded model weights (cached, never re-downloaded).

Wipe all of it — including downloaded models — with `./run.sh down -v`.

## Configuration

The app honors these environment variables. Under Docker, `IMAGEN_HOME` and
`IMAGEN_HOST` are fixed by `docker-compose.yml`; the rest you can set in your
shell (`IMAGEN_PORT`) or by editing the `environment:` block in
`docker-compose.yml`.

| Variable | Default | Meaning |
|----------|---------|---------|
| `IMAGEN_PORT` | `7860` | Host port the UI is served on (read by `run.sh`/compose) |
| `IMAGEN_MODEL` | `stable-diffusion-v1-5/stable-diffusion-v1-5` | Which model loads first |
| `IMAGEN_HOME` | `/data` in Docker (`~/imagen` natively) | Where outputs, db, and models live |
| `IMAGEN_HOST` | `0.0.0.0` in Docker (`127.0.0.1` natively) | Bind address inside the container |
| `IMAGEN_SAFETY_CHECKER` | `off` | Set to `on`/`1`/`true` to keep the SD 1.x safety checker enabled |

The compose file maps the server to `127.0.0.1:${IMAGEN_PORT}` on the host, so
the UI is reachable from your machine but not exposed to the local network.

## Layout

```
run.sh              one-command Docker launcher (starts Docker Desktop, builds, runs)
Dockerfile          CPU-only image: Python + CPU PyTorch + diffusers + the app
docker-compose.yml  service + named volume (imagen-data) wiring
requirements.txt    Python dependencies
app/
  main.py     FastAPI routes + WebSocket progress + serves the web UI
  engine.py   diffusers inference; CPU-only, one model resident at a time
  jobs.py     single-worker generation queue with cancellation
  db.py       SQLite gallery index
  config.py   paths, model catalog, and env config
  models.py   request schema
web/
  index.html · app.js · style.css   no-build web UI
```
