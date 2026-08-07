#!/bin/bash
# OpenClaw Command Center - Launcher
#
# Starts the Node server (and, optionally, a Chromium kiosk). This script is
# deployment-agnostic: it works headless on any Linux/macOS/Windows host as
# well as on the original Raspberry Pi 5 + 7" LCD kiosk. Hardware-specific
# steps (DISPLAY, audio, fullscreen browser) are best-effort and never abort
# startup.
#
# Common overrides (environment variables):
#   PORT=3000            HTTP port the server listens on
#   HOST=0.0.0.0         Bind address
#   COMMANDCENTER_KIOSK=1  Launch a Chromium kiosk pointing at the dashboard
#   KIOSK_URL            Override the dashboard URL (default http://localhost:$PORT)
#   CHROMIUM_BIN         Chromium/Chrome binary (auto-detected if unset)
#   DISPLAY=:0           X display for the kiosk (no-op when unset/headless)
#   AUDIO_CARD           amixer card for volume preset (e.g. 3); skip if empty

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

PORT="${PORT:-3000}"
HOST="${HOST:-0.0.0.0}"
KIOSK_URL="${KIOSK_URL:-http://localhost:${PORT}}"

echo "=== OpenClaw Command Center ==="

# --- Best-effort display / power settings (Pi kiosk). Never fatal. ---
if [ -n "${DISPLAY:-}" ]; then
  xset s off 2>/dev/null || true
  xset -dpms 2>/dev/null || true
  xset s noblank 2>/dev/null || true
fi

# --- Best-effort audio preset. Skip when AUDIO_CARD is unset. ---
if [ -n "${AUDIO_CARD:-}" ]; then
  amixer -c "$AUDIO_CARD" sset Speaker 100% 2>/dev/null || true
  amixer -c "$AUDIO_CARD" sset PCM 100% 2>/dev/null || true
fi

# Kill any existing instances
pkill -f "node server/index.js" 2>/dev/null || true
pkill -f "chromium.*command-center" 2>/dev/null || true
sleep 1

# Start Node server in background
echo "[start] Launching Node server on ${HOST}:${PORT}..."
PORT="$PORT" HOST="$HOST" node server/index.js &
SERVER_PID=$!

# Wait for server to be ready
echo "[start] Waiting for server..."
for i in $(seq 1 40); do
  if curl -s "http://localhost:${PORT}/api/status" > /dev/null 2>&1; then
    echo "[start] Server is ready!"
    break
  fi
  sleep 0.5
done

# Optional Chromium kiosk (headless servers simply skip this)
if [ "${COMMANDCENTER_KIOSK:-0}" = "1" ]; then
  CHROMIUM_BIN="${CHROMIUM_BIN:-$(command -v chromium-browser || command -v chromium || command -v google-chrome || echo chromium-browser)}"
  echo "[start] Launching Chromium kiosk -> ${KIOSK_URL}"
  "$CHROMIUM_BIN" \
    --kiosk \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-translate \
    --no-first-run \
    --start-fullscreen \
    --app="${KIOSK_URL}" \
    2>/dev/null &
fi

echo "[start] Command Center running! (Server PID: ${SERVER_PID})"
echo "[start] Press Ctrl+C to stop"

# Wait for server process
wait "$SERVER_PID"
