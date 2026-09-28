#!/usr/bin/env bash
# Buka Hermes Console tanpa terminal.
#
#   ./start.sh          nyalakan server (kalau belum jalan) lalu buka browser
#   ./start.sh --stop   matikan server
#
# Server dijalankan terpisah dari Termux, jadi kamu bisa tutup Termux dan
# console tetap hidup.

set -uo pipefail
cd "$(dirname "$0")"

PORT="${HERMES_CONSOLE_PORT:-8787}"
URL="http://127.0.0.1:${PORT}/"
PIDFILE="/tmp/hermes-console-${PORT}.pid"
LOG="/tmp/hermes-console-${PORT}.log"

is_up() {
  curl -s -o /dev/null --max-time 3 "${URL}api/health" 2>/dev/null
}

open_browser() {
  for cmd in termux-open-url xdg-open open; do
    if command -v "$cmd" >/dev/null 2>&1; then
      "$cmd" "$URL" >/dev/null 2>&1 &
      return 0
    fi
  done
  echo "Buka manual di browser: $URL"
}

if [ "${1:-}" = "--stop" ]; then
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill "$(cat "$PIDFILE")" && echo "Console dimatikan."
  else
    echo "Console tidak sedang jalan."
  fi
  rm -f "$PIDFILE"
  exit 0
fi

if is_up; then
  echo "Console sudah jalan di $URL"
  open_browser
  exit 0
fi

if [ ! -d dist ]; then
  echo "dist/ belum ada. Jalankan sekali: ./run.sh --no-open" >&2
  exit 1
fi

# Dijalankan lepas dari terminal ini supaya tutup Termux tidak mematikannya.
nohup python3 server.py --port "$PORT" --no-open > "$LOG" 2>&1 &
echo $! > "$PIDFILE"

for _ in $(seq 1 20); do
  sleep 0.5
  if is_up; then
    echo "Console jalan di $URL"
    echo "Log: $LOG"
    open_browser
    exit 0
  fi
done

echo "Gagal menyalakan console. Isi log:" >&2
tail -20 "$LOG" >&2
exit 1
