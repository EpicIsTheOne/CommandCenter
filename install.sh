#!/usr/bin/env bash
# OpenClaw Command Center — one-command installer
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/EpicIsTheOne/CommandCenter/main/install.sh)"
#
# Or, to read it first (recommended for the security-conscious):
#   git clone https://github.com/EpicIsTheOne/CommandCenter.git
#   less CommandCenter/install.sh
#   CommandCenter/install.sh
#
# What it does:
#   1. Clones the repo (or reuses an existing directory)
#   2. Installs dependencies reproducibly (npm ci)
#   3. Creates .env from .env.example, defaulting to DEMO_MODE so the very
#      first launch is a clean simulated preview (no "gateway failed" scare)
#   4. Starts the server, waits for it to come up
#   5. Detects whether agents are present (demo or live)
#   6. If running in a terminal: prompts you to set the operator password,
#      then prints the URL. If piped (e.g. the curl one-liner), it starts the
#      server and tells you to open the URL and set the password in-browser.
#
# Env overrides:
#   CC_DIR           target directory (default: CommandCenter)
#   CC_BRANCH        repo branch to clone (default: main)
#   CC_NO_START=1    install only, don't launch the server
#   CC_NO_DEMO=1     leave DEMO_MODE as shipped in .env.example (live/fallback)
#   CC_SKIP_CLONE=1  assume $CC_DIR already exists (used for local testing)
#   CC_PORT          server port (default: 3000)
#   CC_NO_SETUP=1    skip the interactive password step (start + print URL only)

set -euo pipefail

REPO="EpicIsTheOne/CommandCenter"
BRANCH="${CC_BRANCH:-main}"
DIR="${CC_DIR:-CommandCenter}"
PORT="${CC_PORT:-3000}"
NO_START="${CC_NO_START:-0}"
NO_DEMO="${CC_NO_DEMO:-0}"
NO_SETUP="${CC_NO_SETUP:-0}"
SKIP_CLONE="${CC_SKIP_CLONE:-0}"

# --- colored output helpers ---
info() { printf '\033[36m[cc]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[cc]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[cc]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[cc]\033[0m %s\n' "$*" >&2; exit 1; }

# --- prerequisite checks ---
command -v git  >/dev/null 2>&1 || die "git is required. Install: https://git-scm.com/downloads"
command -v node >/dev/null 2>&1 || die "Node.js 18+ is required. Get it: https://nodejs.org"
command -v npm  >/dev/null 2>&1 || die "npm is required (ships with Node.js)."
node -e 'process.exit(process.versions.node.split(".")[0] >= 18 ? 0 : 1)' 2>/dev/null \
  || die "Node.js 18+ required (found $(node -v)). Update: https://nodejs.org"

# --- clone (or reuse) ---
if [ "${SKIP_CLONE}" = "1" ] && [ -d "$DIR" ]; then
  warn "CC_SKIP_CLONE set and '$DIR' exists — reusing it."
elif [ -d "$DIR" ]; then
  warn "Directory '$DIR' already exists — reusing it instead of cloning."
else
  info "Cloning Command Center (${BRANCH})..."
  git clone --depth 1 --branch "$BRANCH" "https://github.com/${REPO}.git" "$DIR" \
    || die "git clone failed. Check your network and the repo URL."
fi

cd "$DIR"

# --- dependencies ---
info "Installing dependencies (this can take a minute on first run)..."
if [ -f package-lock.json ]; then
  npm ci || npm install
else
  npm install
fi

# --- environment file ---
if [ ! -f .env ]; then
  info "Creating .env from .env.example..."
  cp .env.example .env
  # Demo-first: a clean simulated preview on first launch, no gateway warning.
  if [ "${NO_DEMO}" != "1" ]; then
    if grep -q '^DEMO_MODE=' .env; then
      sed -i 's/^DEMO_MODE=.*/DEMO_MODE=true/' .env
    else
      printf '\nDEMO_MODE=true\n' >> .env
    fi
    info "Set DEMO_MODE=true so the first launch is a clean preview."
    info "Flip it to false (and set GATEWAY_URL) later to go live — see SETUP.md."
  fi
else
  warn ".env already exists — leaving it untouched. Edit it to configure live mode."
fi

# --- launch ---
if [ "${NO_START}" = "1" ]; then
  ok "Install complete. Start it whenever you're ready:"
  ok "  cd $DIR && npm start"
  ok "  then open http://localhost:${PORT}"
  exit 0
fi

info "Starting Command Center (port ${PORT})..."
PORT="$PORT" npm start > /tmp/commandcenter.log 2>&1 &
SERVER_PID=$!

# --- wait for readiness ---
URL="http://localhost:${PORT}"
info "Waiting for server to come up..."
READY=0
for i in $(seq 1 60); do
  if curl -s -m 2 "${URL}/api/status" > /dev/null 2>&1; then READY=1; break; fi
  # Bail early if the process died.
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  sleep 0.5
done
if [ "$READY" != "1" ]; then
  warn "Server did not report ready within 30s. Last log lines:"
  tail -n 15 /tmp/commandcenter.log 2>/dev/null || true
  warn "It may still be starting. Check '${URL}' in your browser."
fi

# --- detect setup state (needed before deciding to prompt for password) ---
AUTH_JSON="$(curl -s -m 3 "${URL}/api/auth/status" 2>/dev/null || echo '{}')"
PASSWORD_SET="$(printf '%s' "$AUTH_JSON" | grep -o '"passwordSet":[a-z]*' | cut -d: -f2 | tr -d ' ' || true)"

# Agent detection must happen AFTER setup, because /api/status is gated until
# the operator password is set. We re-detect right before printing the summary.
# The `|| true` guards keep pipefail from aborting when a field is absent
# (e.g. the pre-setup SETUP_REQUIRED payload has no agents/mode field).
detect_agents() {
  local S
  S="$(curl -s -m 3 -b /tmp/cc-setup-cookie "${URL}/api/status" 2>/dev/null || echo '{}')"
  AGENT_COUNT="$(printf '%s' "$S" | grep -o '"agents":\[[^]]*\]' | grep -o '"id"' | wc -l | tr -d ' ' || true)"
  SETUP_MODE="$(printf '%s' "$S" | grep -o '"mode":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
}

# --- operator password setup ---
if [ "${NO_SETUP}" != "1" ] && [ "${PASSWORD_SET}" != "true" ] && [ -t 0 ]; then
  echo
  info "Command Center needs an operator password (min 12 characters)."
  info "This is loopback-only and never exposed to the network."
  while true; do
    printf '\033[36m[cc]\033[0m Operator password: ' >/dev/tty
    stty -echo < /dev/tty
    IFS= read -r PW < /dev/tty
    stty echo < /dev/tty
    echo
    if [ "${#PW}" -lt 12 ]; then
      warn "Password must be at least 12 characters. Try again."
      continue
    fi
    RESP="$(curl -s -m 5 -c /tmp/cc-setup-cookie -X POST "${URL}/api/auth/setup" \
      -H 'Content-Type: application/json' \
      -d "{\"password\":\"${PW}\"}" 2>/dev/null || echo '{}')"
    if printf '%s' "$RESP" | grep -q '"ok":true'; then
      ok "Operator password set."
    else
      warn "Password setup did not confirm (response: ${RESP})."
      warn "You can set it from the browser instead. Continuing..."
    fi
    break
  done
fi

# --- summary ---
detect_agents
echo
ok "=============================================="
ok " Command Center is running!"
ok "=============================================="
if [ -n "${AGENT_COUNT}" ] && [ "${AGENT_COUNT}" -gt 0 ] 2>/dev/null; then
  ok " Detected ${AGENT_COUNT} agent(s) (mode: ${SETUP_MODE:-unknown})."
else
  warn " No agents detected yet — demo mode shows simulated activity."
  warn " Set DEMO_MODE=false + GATEWAY_URL in .env to connect real agents."
fi
echo
ok " Open it here:  ${URL}"
if [ "${PASSWORD_SET}" != "true" ]; then
  info " First launch: set your operator password in the browser."
fi
echo
warn " Server is running in the background (PID ${SERVER_PID})."
warn " Stop it later with:  pkill -f 'node server/index.js'"
