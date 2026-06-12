#!/usr/bin/env bash
# Run imagen entirely inside Docker — nothing (Python, torch, models) is
# installed on the host. All runtime data lives in the `imagen-data` Docker
# volume; wipe it (including downloaded models) with: docker compose down -v
#
# NOTE: Docker on macOS has no GPU access, so generation runs CPU-only and is
# slow (minutes per image). SDXL may need more RAM in Docker Desktop's settings.
set -euo pipefail
cd "$(dirname "$0")"

# The Docker daemon (Docker Desktop on macOS) must be running — start it if not,
# then wait for it to come up so you only ever have to run this one script.
if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon isn't running — starting Docker Desktop…"
  open -a Docker || { echo "Couldn't launch Docker Desktop. Is it installed?" >&2; exit 1; }
  printf "Waiting for Docker to be ready"
  for _ in $(seq 1 90); do          # up to ~90s
    if docker info >/dev/null 2>&1; then echo " ready."; break; fi
    printf "."; sleep 1
  done
  if ! docker info >/dev/null 2>&1; then
    echo $'\nDocker did not come up in time. Open Docker Desktop manually and re-run ./run.sh.' >&2
    exit 1
  fi
fi

PORT="${IMAGEN_PORT:-7860}"
echo "imagen → http://127.0.0.1:$PORT  (CPU-only inside Docker; first run builds the image)"

# Pass through any extra args (e.g. ./run.sh down, ./run.sh down -v); with no
# args, build the image if needed and start the server in the foreground.
if [ "$#" -gt 0 ]; then
  exec docker compose "$@"
fi
exec docker compose up --build
