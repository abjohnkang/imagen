#!/usr/bin/env bash
# Set up the venv (first run only), then launch the imagen server.
set -euo pipefail
cd "$(dirname "$0")"

VENV=".venv"
if [ ! -d "$VENV" ]; then
  echo "Creating virtualenv…"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --upgrade pip
  echo "Installing dependencies (first run downloads PyTorch — this takes a while)…"
  "$VENV/bin/pip" install -r requirements.txt
fi

HOST="${IMAGEN_HOST:-127.0.0.1}"
PORT="${IMAGEN_PORT:-7860}"
echo "imagen → http://$HOST:$PORT"
exec "$VENV/bin/uvicorn" app.main:app --host "$HOST" --port "$PORT"
