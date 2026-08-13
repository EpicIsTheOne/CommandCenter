# Command Center — Setup Instructions

This is the practical install flow for getting CommandCenter running without mystery failures.

---

## 1) Prerequisites

Verify:
- **Node.js 18+** — `node --version`
- **npm** — `npm --version`
- **OpenClaw CLI** — `openclaw --version` (needed for live OpenClaw mode)
- **Hermes CLI** — `hermes --help` (only needed if you want Hermes integration/bridge enabled)
- **ffmpeg** — required for audio normalization/transcription

If Node.js or ffmpeg is missing, install them first.

## 2) Install

```bash
npm ci
cp .env.example .env
```

(`npm install` is fine too, but `npm ci` is preferred for reproducible fresh-instance verification.)

## 2.5) Copy/paste quick start (demo mode)

```bash
npm ci && cp .env.example .env
sed -i 's/^DEMO_MODE=.*/DEMO_MODE=true/' .env
npm start
```

Open `http://localhost:3000`.

## 2.6) Copy/paste quick start (live mode, same host as OpenClaw)

```bash
npm ci && cp .env.example .env
sed -i 's/^DEMO_MODE=.*/DEMO_MODE=false/' .env
sed -i 's|^GATEWAY_URL=.*|GATEWAY_URL=ws://127.0.0.1:18789|' .env
sed -i 's/^GATEWAY_TOKEN=.*/GATEWAY_TOKEN=/' .env
npm start
```

Then verify status:

```bash
curl -s http://localhost:3000/api/status
```

Expected output (minimum):
- `setup.mode` is `demo` (demo run) or `live` (live run)
- `setup.gatewayConnected` is `true` for live mode
- `setup.issues` is empty or only informational

If you want a public CommandCenter plus a same-machine automation API, also set:

```env
COMMANDCENTER_API_KEY=replace_me_with_a_real_secret
LOCAL_API_ENABLED=true
LOCAL_API_HOST=127.0.0.1
LOCAL_API_PORT=3001
```

That gives you:
- public/network API on `HOST:PORT` that requires `Authorization: Bearer <COMMANDCENTER_API_KEY>`
- local loopback API on `http://127.0.0.1:3001/api/v1/*` with no bearer token required

For same-machine apps, the usual first calls are:
- `GET /api/v1/agents`
- `POST /api/v1/sessions`
- `POST /api/v1/sessions/:id/messages`
- or `POST /api/v1/chat` if you want a simpler wrapper

## 3) Choose your mode first

This is the most important setup decision.

Also: Hermes and OpenClaw do **not** need separate CommandCenter installs. If you enable both, they can co-exist inside the same dashboard and the same merged roster.

### Demo mode
Use this if you just want to preview the UI.

```env
DEMO_MODE=true
```

What demo mode means:
- the interface works
- agent activity may be simulated
- OpenClaw does **not** need to be connected

### Live OpenClaw mode
Use this if you want real agents.

```env
DEMO_MODE=false
GATEWAY_URL=ws://127.0.0.1:18789
```

For live mode, CommandCenter needs a valid OpenClaw gateway token.

Good news: if CommandCenter is running on the same machine as OpenClaw, it now tries to auto-detect the token from `~/.openclaw/openclaw.json` when `GATEWAY_TOKEN` is blank.

If that auto-detect fails for any reason, the Setup Status block should now say so clearly instead of pretending live mode succeeded.

If you want to set it manually, add:

```env
GATEWAY_TOKEN=your_openclaw_gateway_token_here
```

### Optional Hermes bridge integration

If you also want Hermes agents to appear in CommandCenter, enable the Hermes bridge:

```env
HERMES_BRIDGE_ENABLED=true
HERMES_BIN=hermes
```

What this does:
- CommandCenter asks the Hermes CLI for available profiles
- Hermes profiles are merged into the same office roster as OpenClaw agents
- Hermes session activity can be mirrored into the same Activity Log/office state stream

How detection works under the hood:
- OpenClaw agents come from `~/.openclaw/openclaw.json` → `agents.list`
- Hermes agents come from `hermes profile list` plus `hermes profile show <profile>`
- both are normalized into the same roster shape used by `GET /api/v1/agents`
- each agent includes a `source` field (`openclaw` or `hermes`)
- `primaryAgentId` is chosen from the merged roster and is the safest default target for automations or super apps

This is additive, not exclusive.
You can run:
- OpenClaw only
- Hermes only
- both OpenClaw and Hermes together

## 3.5) Updater behavior

CommandCenter now includes a built-in updater in **Settings → Updates**.

What it gives you:
- **Auto update toggle** enabled by default
- manual **Update Now** button
- confirmation modal before the update actually applies
- pending commit list
- changed-file preview
- trimmed code diff preview
- latest commit message / release-note style text when available

Important behavior:
- updates are blocked if the local repo has uncommitted changes
- applying an update pulls from the repo, installs dependencies if needed, and restarts CommandCenter
- updater preferences/state are stored locally in `data/update-settings.json` and `data/update-state.json`

If you are preparing an instance for someone else, you usually do **not** need to preconfigure anything in `.env` for updates.
Just make sure the repo was cloned normally and the host can reach GitHub.

## 4) Voice setup

Voice is no longer just “paste OpenAI key.” There are separate input and output systems.

### Listening / STT
Choose one:
- **Local Whisper on this server**
- **AIChat STT API**

If using AIChat STT API, CommandCenter supports:
- Fish Audio STT
- OpenAI STT
- ElevenLabs STT

### Speaking / TTS
Choose one:
- **Fish Audio via AIChat tagged API**
- **ElevenLabs**
- fallback: **espeak-ng** if premium TTS is not configured

### Recommended default for Epic’s setup
- STT: **AIChat API → Fish Audio**
- TTS: **Fish Audio via AIChat**

Most voice configuration is done in the **Settings** UI after boot.

## 5) Start the server

```bash
npm start
```

## 5.5) Optional Windows relay client

The repository includes a portable Windows client at `client/command-center-relay.cmd`. It enrolls with the dedicated V1 device WebSocket, discovers local Hermes profiles, and publishes status, roster, presence, heartbeat, and bounded activity data. It accepts one authenticated, correlated Hermes chat exchange so Fairy and Command Center can route work to the remote agent; it does not expose shell, generic command, or arbitrary action requests.

See [client/README.md](./client/README.md) for pairing and DPAPI credential-storage instructions.

## 6) Open the app

Visit:
- `http://localhost:3000`
- or `https://localhost:3000` if you generated certs

## 7) Read the setup status before testing voice

Open **Settings** and check the **Setup Status** block.

While you are there, open **Updates** once and make sure it can read the repo cleanly.
That panel should show whether you are:
- already up to date
- waiting on incoming commits
- blocked by local uncommitted changes
- or currently applying an update

It should tell you whether you are in:
- **Demo Mode**
- **Live Connected**
- **Demo Fallback**
- **Connecting**

You can also verify quickly via API:

```bash
curl -s http://localhost:3000/api/status
```

Look at `setup.mode`, `setup.modeLabel`, `setup.gatewayConnected`, and `setup.issues`.

If live connection fails, CommandCenter should now make that obvious instead of quietly pretending everything is fine.

## 8) Common first-run problems

### UI looks alive, but agents are fake
You are probably in **demo mode** or **demo fallback**.

### Gateway auth failed
Your `GATEWAY_TOKEN` is wrong, stale, or missing.

Quick checks:
- If running on the same host as OpenClaw, leave `GATEWAY_TOKEN` blank and restart CommandCenter so auto-detect can run.
- If setting manually, ensure it matches OpenClaw `gateway.auth.token` exactly.
- Recheck status using `/api/status` and confirm whether mode is `live` or `demo-fallback`.

### Public API says key required
If you hit the public/network-facing `/api/v1` listener without configuring `COMMANDCENTER_API_KEY`, CommandCenter now returns `PUBLIC_API_KEY_REQUIRED`.

Quick fix:
- set `COMMANDCENTER_API_KEY` in `.env`
- restart CommandCenter
- keep local automation on `127.0.0.1:3001` if you want no-key same-machine access

### Updates panel says update blocked
That usually means the repo has local uncommitted changes.

Quick checks:
- run `git status --short`
- commit/stash/discard local edits first
- re-open **Settings → Updates** and refresh status

The updater is intentionally conservative here so it does not overwrite local work.

### Voice records but no transcript comes back
Usually one of these:
- STT provider is not configured
- AIChat STT base URL is wrong
- audio format was rejected upstream

### Agent replied in logs, but no audio played
Usually TTS is unconfigured or browser playback/autoplay got blocked.

## 9) Optional HTTPS certs

Only needed if your browser/device requires HTTPS:

```bash
openssl req -x509 -newkey rsa:2048 -keyout server/key.pem -out server/cert.pem -days 365 -nodes -subj '/CN=localhost'
```

## 10) What to report after setup

Tell the user:
- which URL the app is running on
- whether it is in **demo**, **live**, or **demo fallback** mode
- whether gateway auth succeeded
- which STT/TTS providers are selected
- whether voice was actually tested successfully
