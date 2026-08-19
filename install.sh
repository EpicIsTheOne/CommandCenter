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
#   4. Starts the server and waits for it to come up
#
# Env overrides:
#   CC_DIR           target directory (default: CommandCenter)
#   CC_BRANCH        repo branch to clone (default: main)
#   CC_NO_START=1    install only, don't launch the server
#   CC_NO_DEMO=1     leave DEMO_MODE as shipped in .env.example (live/fallback)
#   CC_SKIP_CLONE=1  assume $CC_DIR already exists (used for local testing)

set -euo pipefail

REPO="EpicIsTheOne/CommandCenter"
BRANCH="${CC_BRANCH:-main}"
DIR="${CC_DIR:-CommandCenter}"
NO_START="${CC_NO_START:-0}"
NO_DEMO="${CC_NO_DEMO:-0}"
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
  ok "  then open http://localhost:3000"
  exit 0
fi

info "Starting Command Center..."
npm start
