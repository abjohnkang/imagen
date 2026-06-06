# imagen

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