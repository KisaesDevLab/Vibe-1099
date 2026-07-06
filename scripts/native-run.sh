#!/usr/bin/env bash
# Vibe 1099 — foreground launcher for a native (Dockerless) install.
#
# Starts all four processes (render sidecar, api, worker, web) in the foreground
# and shuts them all down on Ctrl-C. Use this for a quick start or when you did a
# native install with --no-systemd. For an unattended box, prefer the systemd
# units the installer writes (scripts/install.sh --mode native).
#
# Reads configuration from ./.env (created by the installer).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "error: .env not found. Run: scripts/install.sh --mode native" >&2
  exit 1
fi

# Export every KEY=VALUE from .env into the environment for the Node processes
# (production `start` scripts read process.env directly — no dotenv).
set -a
# shellcheck disable=SC1091
. ./.env
set +a

RENDER_DIR="$ROOT/render"
VENV="$RENDER_DIR/.venv"
if [[ ! -x "$VENV/bin/gunicorn" ]]; then
  echo "error: render venv missing ($VENV). Run the installer first." >&2
  exit 1
fi

pids=()
cleanup() {
  echo
  echo "shutting down…"
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "→ render  http://127.0.0.1:8212"
( cd "$RENDER_DIR" && exec "$VENV/bin/gunicorn" --bind 127.0.0.1:8212 --workers 2 --timeout 120 app:app ) &
pids+=($!)

echo "→ api     http://127.0.0.1:${API_PORT:-8210}"
pnpm --filter @vibe1099/api start &
pids+=($!)

echo "→ worker"
pnpm --filter @vibe1099/worker start &
pids+=($!)

echo "→ web     http://127.0.0.1:8211"
WEB_PORT=8211 API_TARGET="http://127.0.0.1:${API_PORT:-8210}" node "$ROOT/scripts/serve-web.mjs" &
pids+=($!)

echo
echo "Vibe 1099 is up. Open http://localhost:8211  (Ctrl-C to stop)"
wait
