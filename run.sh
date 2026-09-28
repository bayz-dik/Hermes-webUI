#!/usr/bin/env bash
# Start the Hermes Console: build if needed, then serve it.
#
#   ./run.sh            start on port 8787 and open a browser
#   ./run.sh --port N   use another port
#   ./run.sh --no-build skip the build step (serves the existing dist/)
#   ./run.sh --no-open  do not try to open a browser
#   ./run.sh --dev      start the Vite dev server instead (hot reload)
#
# The server binds 127.0.0.1 only. It runs the agent, so it is never exposed to
# the network.

set -euo pipefail
cd "$(dirname "$0")"

PORT=8787
BUILD=1
DEV=0
OPEN=1

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:?--port needs a number}"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    --no-open) OPEN=0; shift ;;
    --dev) DEV=1; shift ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "node is required to build the UI." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required to run the server." >&2; exit 1; }

if [ "$DEV" -eq 1 ]; then
  [ -d node_modules ] || npm install --no-audit --no-fund
  if ! curl -s -o /dev/null --max-time 3 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null; then
    echo "Warning: no console server on 127.0.0.1:${PORT}."
    echo "The dev page needs it for the API and its session token. Start it with:"
    echo "  python3 server.py --port ${PORT} --no-open"
    echo ""
  fi
  echo "Dev server: http://127.0.0.1:5173/ (proxying /api to 127.0.0.1:${PORT})"
  HERMES_CONSOLE_PORT="$PORT" exec ./node_modules/.bin/vite
fi

if [ "$BUILD" -eq 1 ]; then
  if [ ! -d node_modules ]; then
    echo "Installing frontend dependencies..."
    npm install --no-audit --no-fund
  fi
  if [ ! -f node_modules/lucide-static/icons/check.svg ]; then
    npm install --no-audit --no-fund
  fi
  echo "Generating icons and typechecking..."
  node scripts/gen-icons.mjs
  ./node_modules/.bin/tsc --noEmit
  echo "Building..."
  ./node_modules/.bin/vite build
fi

if [ "$OPEN" -eq 1 ]; then
  exec python3 server.py --port "$PORT"
fi
exec python3 server.py --port "$PORT" --no-open
