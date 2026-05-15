# OpenClaw Command Center — Setup Instructions

This is the practical install flow for getting CommandCenter running without mystery failures.

---

## 1) Prerequisites

Verify:
- **Node.js 18+** — `node --version`
- **npm** — `npm --version`
- **OpenClaw CLI** — `openclaw --version` (only needed for live mode)
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

## 3) Choose your mode first

This is the most important setup decision.

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

## 6) Open the app

Visit:
- `http://localhost:3000`
- or `https://localhost:3000` if you generated certs

## 7) Read the setup status before testing voice

Open **Settings** and check the **Setup Status** block.

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
