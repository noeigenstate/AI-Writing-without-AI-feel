#!/usr/bin/env bash
#
# One-click launcher for AI写作.
# Starts the backend and the frontend dev server together, installing
# dependencies and creating backend/.env on first run.
#
# Usage:
#   ./run.sh
# On Windows, run it from Git Bash (or WSL).
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

# --- preflight ---------------------------------------------------------------
command -v node >/dev/null 2>&1 || { echo "✗ Node.js not found. Install Node 18+ and retry."; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "✗ npm not found. Install Node 18+ and retry."; exit 1; }

# Create backend/.env from the example on first run.
if [ ! -f "$BACKEND/.env" ]; then
  echo "• backend/.env not found — creating it from .env.example"
  cp "$BACKEND/.env.example" "$BACKEND/.env"
  echo "  ⚠  Edit backend/.env and set your model API key."
  echo "     (Article generation needs a key; the AI-smell score works fully offline.)"
fi

# Install dependencies if missing.
if [ ! -d "$BACKEND/node_modules" ]; then
  echo "• Installing backend dependencies..."
  (cd "$BACKEND" && npm install)
fi
if [ ! -d "$FRONTEND/node_modules" ]; then
  echo "• Installing frontend dependencies..."
  (cd "$FRONTEND" && npm install)
fi

# --- run both, and stop both on Ctrl+C / exit --------------------------------
pids=()
cleanup() {
  echo
  echo "Stopping AI写作..."
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

# Node 24+ can route built-in fetch/http traffic through inherited
# HTTP_PROXY / HTTPS_PROXY values. The backend also applies .env values after
# dotenv loads on Node 24.14+.
export NODE_USE_ENV_PROXY=1
EXISTING_NO_PROXY="${NO_PROXY:-${no_proxy:-}}"
export NO_PROXY="localhost,127.0.0.1${EXISTING_NO_PROXY:+,$EXISTING_NO_PROXY}"
export no_proxy="$NO_PROXY"

FRONTEND_PORT="${FRONTEND_PORT:-$(node "$ROOT/scripts/find-open-port.mjs" 51773)}"
export FRONTEND_PORT
export CORS_ORIGINS="http://127.0.0.1:${FRONTEND_PORT},http://localhost:${FRONTEND_PORT}"
if [ "$FRONTEND_PORT" != "51773" ]; then
  echo "• Port 51773 is occupied; using $FRONTEND_PORT instead."
fi

echo "▶ Starting backend  → http://127.0.0.1:8787"
(cd "$BACKEND" && npm start) &
pids+=("$!")

echo "▶ Starting frontend (dev server URL is printed below)"
(cd "$FRONTEND" && npm run dev) &
pids+=("$!")

echo
echo "AI写作 is starting. Open the frontend URL shown above in your browser."
echo "Press Ctrl+C or run ./stop.sh from another shell to stop both servers."

# Exit (and trigger cleanup) as soon as either server stops.
wait -n
