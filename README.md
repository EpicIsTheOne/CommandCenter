# Command Center

> Security release note (July 2026): browser control APIs and realtime WebSockets now require operator authentication. First-time password setup is loopback-only, passwords require at least 12 characters, the public `/api/v1` surface requires a bearer token, and the optional no-key API bypass is accepted only from a loopback peer on the configured local listener.

_A self-hosted AI command center that turns your agent stack into a living pixel-art operations dashboard._

![Command Center](public/docs/command-center-preview.png)

Command Center is a live visual cockpit for OpenClaw and Hermes. It gives you a pixel-art office where agents show up, move around, speak, react, and surface activity in real time — with voice I/O, direct chat, Fairy Live, and a terminal-style log that makes your local AI system feel alive instead of buried behind another plain chat window.

OpenClaw handles sessions, tools, routing, and gateway events. Command Center is the interface layer that makes that activity watchable and steerable. If you also run Hermes, it can pull Hermes-managed agents into the same roster so both systems share one office and one status surface. Grab OpenClaw here: [https://openclaw.ai/](https://openclaw.ai/).

This project also builds on the original work by mayukh4. It was forked from [mayukh4/openclaw-command-center](https://github.com/mayukh4/openclaw-command-center), and that original repo provided the vision and foundation that made this version possible.

## Why it stands out

- **Living pixel-art AI ops dashboard** instead of a static admin panel
- **Unified OpenClaw + Hermes presence** in the same office and roster
- **Outside-session awareness** so work happening beyond the UI can still appear in the dashboard
- **Voice-first interaction** with per-agent voices, wake mode, and spoken responses
- **Fairy Live** for realtime calls with mic, screen share, and camera input
- **Custom companion / Codex pet visuals** for agents and imported characters

## Marquee Features

### 1. Living pixel-art AI ops dashboard
Watch your agents think, work, talk, wander, and gather inside a live office instead of staring at another dead chat pane.

### 2. Unified OpenClaw + Hermes cockpit
Run OpenClaw agents, Hermes-managed agents, or both together in one shared roster and one command surface.

### 3. Outside-session awareness
Command Center can reflect activity happening beyond its own UI, turning it into a real status board for your agent system.

### 4. Voice, direct chat, and wake mode
Talk to the mascot, talk to individual agents, trigger wake flows, or use direct text chat without losing the live visual layer.

### 5. Fairy Live realtime calls
Launch realtime Fairy sessions with mic, screen sharing, camera input, and mobile-friendly camera switching.

### 6. Built-in updater and patch flow
Check for new versions, preview commits/files/diffs, enable automatic updates, and patch the running CommandCenter instance without needing a separate agent workflow.

### 7. Companion and Codex pet customization
Assign companion visuals, import Codex pets, and give each agent more personality than the average enterprise dashboard could ever survive.

## Screenshots / Demo

![Command Center Screenshot 1](public/docs/screenshot-1.png)
![Command Center Screenshot 2](public/docs/screenshot-2.png)

### Feature highlights

- **Watch agents work in real time** through a living office view, status panel, and terminal-style activity log.
- **Run OpenClaw and Hermes side by side** in one merged roster and one dashboard.
- **Talk to agents directly** with voice input/output, per-agent voices, wake mode, and direct chat.
- **Mirror activity from outside the UI** so Command Center becomes a real system surface, not just a chat wrapper.
- **Launch Fairy Live sessions** with realtime mic, screen, and camera sharing.
- **Customize the vibe** with companions, Codex pets, ambient widgets, kiosk/PWA support, and responsive layouts.

## Theme / Inspiration

The current default theme, agent names, and companion visuals are inspired by **Zenless Zone Zero** (the HoYoverse gacha game), because operations should look cool. It’s purely cosmetic though — the system works with any OpenClaw agent names and any Codex pet companions you want to run.

## Quick Start

```bash
git clone https://github.com/EpicIsTheOne/CommandCenter.git
cd CommandCenter
npm install
cp .env.example .env
npm start
# Open http://localhost:3000
```

With zero config, the app runs in **demo mode** with simulated agent activity.

> Need the full install/config flow, troubleshooting, and live-mode details?
> See **[SETUP.md](./SETUP.md)** for the complete setup guide.

For **live OpenClaw integration**:
- set `DEMO_MODE=false`
- point `GATEWAY_URL` at your OpenClaw gateway
- either set `GATEWAY_TOKEN` manually **or** let CommandCenter auto-detect it from `~/.openclaw/openclaw.json` when running on the same machine

For **Hermes integration/bridge**:
- set `HERMES_BRIDGE_ENABLED=true`
- make sure the `hermes` CLI is installed and available on `PATH` (or set `HERMES_BIN`)
- CommandCenter will detect Hermes profiles and add them to the roster alongside OpenClaw agents
- **Hermes and OpenClaw can co-exist in the same CommandCenter instance** — you do **not** need separate installs, separate dashboards, or a Hermes-only deployment

Open **Settings** after boot and check the **Setup Status** section. It should clearly tell you whether you are:
- in demo mode on purpose
- live and connected
- or stuck in demo fallback because gateway auth/connection failed

## What You'll See

The UI has three main zones:

- **Status / Mascot** — animated mascot canvas that reacts to listening, thinking, working, talking, and error states.
- **Office** — pixel-art office showing agents at desks, wandering around, gathering at the center table, using companion visuals, and reacting to tasks.
- **Activity Log** — terminal-style log for agent activity, tool calls, outside-session responses, voice events, and system status.

Additional panels and modals provide:

- settings for voice providers and per-agent voices
- built-in updater controls with auto-update toggle, confirmation modal, commit/file previews, and diff preview
- companion/pet import and assignment
- wake-word configuration
- direct chat with reusable file/link context
- API/docs access under `/docs`

## Current Feature Set

### Live OpenClaw + Hermes activity

- WebSocket bridge to the OpenClaw gateway.
- Optional Hermes bridge/profile detection for Hermes-managed agents.
- OpenClaw and Hermes agents can appear in the same office/roster at the same time.
- Demo fallback if the gateway is unavailable.
- Automatic recovery retry after temporary gateway outage, so a brief OpenClaw restart does not leave CommandCenter stuck in permanent demo fallback.
- Normalized agent states:
  - idle
  - listening
  - thinking
  - tool use / working
  - responding / talking
  - error
- Session monitor that watches OpenClaw session files and mirrors outside activity into Command Center.
- External replies now show in the Activity Log and get spoken by Command Center, even when the conversation started outside the Command Center UI.
- Duplicate response suppression so mirrored events do not spam the log or double-speak.

### Voice input and speech output

- Tap the mascot to talk to the primary agent.
- Tap an office agent to talk directly to that agent.
- Local/server STT route via `/api/voice/transcribe`.
- TTS playback via `/api/voice/speak`.
- Stop Voice button to interrupt playback.
- Per-agent voice assignment.
- Voice provider settings:
  - ElevenLabs
  - Fish Audio through the AIChat tagged API
- Fish Audio voice search and preview support.
- Optional asterisk/narration handling for Fish Audio output.

### Wake mode

- Wake Mode button in the Activity Log header.
- Local wake/name detection flow.
- Picovoice/Porcupine runtime support through bundled browser vendor scripts.
- Built-in Porcupine wake words.
- Uploadable custom `.ppn` wake-word files per agent.
- Wake aliases for common agent names.
- Inline wake requests: if the wake phrase includes a request after the name, Command Center can send it directly.

### Direct chat

- Direct text chat with agents without using voice.
- Persistent per-agent chat history stored under `data/chat-library/history.json`.
- Reusable file/link library stored under `data/chat-library/`.
- Upload files for later reference.
- Save URL/link references with notes.
- Attach saved files/links to direct chat requests.
- Direct chat responses broadcast back into the office/activity system.

### Built-in updater

- Update section inside **Settings**.
- **Auto update toggle** enabled by default.
- Manual **Update Now** flow with confirmation modal before applying changes.
- Git-backed update checks against the configured repo/branch.
- Pending commit list with commit subjects/body text when available.
- Changed-file preview with per-file line add/delete counts.
- Trimmed patch/diff preview so operators can inspect incoming code changes before updating.
- Dirty-working-tree protection so CommandCenter does not blindly stomp local uncommitted changes.
- Automatic restart after successful update apply.
- Post-restart update-state tracking so the UI can report when the update actually landed.

### Companion visuals and Codex pet imports

- Per-agent visual mode:
  - default Command Center pixel agent
  - companion-style animated character
  - imported Codex pet
- Companion settings UI.
- Import Codex pets from:
  - extracted folder path containing `pet.json` and spritesheet assets
  - uploaded folder from your device
  - uploaded `.zip` package
- Codex `pet.json` animation map inference.
- Codex spritesheet rendering using stable row selection.
- Fixed Codex pet running animation flicker by locking walking/running render state while moving.
- Codex pet ambient idle animations:
  - waiting
  - review
  - waving
  - jumping
  - failed
- Direction-aware movement rows for imported pets:
  - running right
  - running left
  - walk up
  - walk down
- Safe animation fallbacks when a pet is missing a specific row/frame count.

### Office simulation

- Pixel-art office with desks, server rack, coffee machine, bookshelf, sofa, water cooler, and center table.
- Mood-driven agent behavior:
  - focused
  - restless
  - curious
  - social
  - tired
  - chaotic
- Weighted random wandering instead of obvious fixed loops.
- Recent-action penalties so agents avoid repeating the same destination too often.
- Idle micro-actions:
  - brief thoughts
  - tiny position shifts
  - facing changes
  - looking up
  - short pauses
- Time-aware behavior:
  - more coffee behavior in the morning
  - more sofa breaks during afternoon/tired moods
  - calmer late-night behavior
- Rarer center-table huddles.
- Randomized huddle topics and lines, including shipping, bugs, design, ops, ideas, users, lore, planning, code, and vibes.
- Huddles now trigger less often and feel less synchronized.
- State bubbles and thought bubbles for task states and ambient actions.
- Transient tool bubbles with badges like `WEB`, `RD`, `WR`, `CMD`, `FND`, `MEM`, `IMG`, and `CLK`.

### System and ambient widgets

- Real system health display:
  - CPU
  - memory
  - disk
  - temperature where available
- Weather widget powered by wttr.in.
- Rain ambience when weather codes indicate rain.
- Kanban-style whiteboard for agent/task state.
- Digital clock using normal 12-hour time with AM/PM.
- Hourly chime.
- Ambient keyboard clicks while agents are working.
- Task completion ding.
- Night overlay after hours.
- Adjustable vignette:
  - overall strength
  - top intensity
  - side intensity
  - bottom intensity

### API and docs

- Static API docs are served from `/docs` when deployed with the bundled docs files.
- OpenAPI document at `public/docs/openapi.json`.
- Auth-protected `/api/v1` routes on the public listener, plus an optional localhost-only API listener for trusted local programs.
- API support for:
  - agents
  - agent search
  - file upload/link library
  - voice settings
  - Fairy live config/sessions/memory
  - sessions
  - chat messages
  - streaming chat messages

### Fairy live UI highlights

- Fairy Live supports realtime call sessions with:
  - mic capture
  - screen sharing
  - camera sharing
  - front/back camera switching on mobile when supported by the browser/device
  - a tiny in-panel live camera preview so you can see what Fairy is being shown
- Fairy suppresses the normal Command Center agent TTS while a Fairy live call is active, so you do not get overlapping voices from two different layers.
- The top activity header now wraps more cleanly on smaller/mobile screens, including the connection badge and quick action buttons.
- Command Center can now be installed as a PWA/app from supported browsers, with an install entry in Settings and iOS fallback guidance via Add to Home Screen.

### Fairy API (`/api/v1/fairy`)

These endpoints are auth-protected on the public listener and available without a bearer token on the optional localhost-only API listener.

- `GET /api/v1/fairy/config`
  - Returns current Fairy/Gemini live runtime config (model, voice, persona, memory flags, etc).
- `GET /api/v1/fairy/sessions`
  - Lists active/recent call sessions where `persona === "fairy"`.
- `GET /api/v1/fairy/sessions/:id`
  - Returns one Fairy call session by id.
- `GET /api/v1/fairy/memory?q=<query>&scope=<scope>`
  - Reads local Fairy memory entries (`data/fairy-memory.json`) with optional query/scope filtering.

Example requests:

```bash
# 1) Read Fairy runtime config
curl -H "Authorization: Bearer $COMMANDCENTER_API_KEY" \
  http://localhost:3000/api/v1/fairy/config

# 2) List Fairy sessions
curl -H "Authorization: Bearer $COMMANDCENTER_API_KEY" \
  http://localhost:3000/api/v1/fairy/sessions

# 3) Get one Fairy session
curl -H "Authorization: Bearer $COMMANDCENTER_API_KEY" \
  http://localhost:3000/api/v1/fairy/sessions/<session-id>

# 4) Search Fairy memory by query/scope
curl -H "Authorization: Bearer $COMMANDCENTER_API_KEY" \
  "http://localhost:3000/api/v1/fairy/memory?q=voice&scope=general"
```

## The Team

The default/example roster may include agents like:

| Agent | ID | Role | Color | Notes |
|-------|----|------|-------|-------|
| Main / Jansky / Astra-style primary | `main` or configured primary | Boss/orchestrator | Gold | Primary voice/masthead agent |
| Orbit | `claw-1` | Coding/tasks | Cyan | Example sub-agent |
| Nova | `claw-2` | Research/web | Purple | Example sub-agent |

The actual roster is loaded from the local OpenClaw configuration and/or Hermes profiles, so your local names may differ.

### How agent detection actually works

CommandCenter builds its roster in `server/agents.js`.

#### OpenClaw agent detection

- Reads `~/.openclaw/openclaw.json`
- Looks for `agents.list`
- Normalizes each entry into the CommandCenter roster shape
- Preserves useful fields such as:
  - `id`
  - `name`
  - `workspace`
  - `model`
- Marks each detected agent with:
  - `source: "openclaw"`
  - `bridge: "openclaw"`

OpenClaw detection is enabled by default unless you explicitly disable it with:

```env
OPENCLAW_AGENT_SOURCE_ENABLED=false
```

#### Hermes agent detection

- Runs `hermes profile list`
- Parses the Hermes profile table output
- Runs `hermes profile show <profile>` for each profile to gather extra details
- Uses the Hermes profile path to optionally inspect `SOUL.md` and derive a nicer assistant/display name
- Normalizes each Hermes profile into the same roster shape used by OpenClaw agents
- Marks each detected Hermes agent with:
  - `source: "hermes"`
  - `bridge: "hermes"`

Hermes detection is enabled only when:

```env
HERMES_BRIDGE_ENABLED=true
```

#### Merge behavior

CommandCenter merges OpenClaw and Hermes agents into one roster.

- OpenClaw agents are loaded first
- Hermes agents are appended after that
- duplicate `id` values are skipped
- the primary agent is chosen in this order:
  1. `orchestrator`
  2. any agent marked `isBoss`
  3. the first available agent

If nothing is available, CommandCenter falls back to a minimal placeholder `main` agent so the UI does not fully implode.

#### Roster shape your super app should expect

`GET /api/v1/agents` returns:

```json
{
  "ok": true,
  "agents": [
    {
      "id": "orchestrator",
      "label": "Astra",
      "name": "Astra / Mission Orchestrator",
      "source": "openclaw",
      "bridge": "openclaw",
      "workspace": "/root/.openclaw/workspaces/orchestrator",
      "model": "openai-codex/gpt-5.4",
      "aliases": ["orchestrator", "Astra"],
      "visual": { "agentId": "orchestrator", "mode": "default" }
    }
  ],
  "primaryAgentId": "orchestrator"
}
```

For super-app integration, the safest fields to rely on are:

- `id` — stable command target
- `label` — short UI label
- `name` — fuller display name
- `source` / `bridge` — tells you whether the agent came from OpenClaw or Hermes
- `workspace` — useful for local tooling / context
- `model` — display/debug info
- `aliases` — good for search UX
- `primaryAgentId` — best default target

Treat `visual`, `color`, and `voice` as presentation metadata, not your core routing contract.

### Hermes + OpenClaw co-existence

CommandCenter does not force an either/or choice here.

If OpenClaw is enabled, it loads agents from your OpenClaw config.
If the Hermes bridge is also enabled, it additionally loads Hermes profiles and merges them into the same live roster.

That means you can:
- run OpenClaw-only
- run Hermes-only
- or run both together in one CommandCenter instance

You do **not** need separate dashboards just because some agents come from OpenClaw and others come from Hermes.

## Architecture

### Server (`server/`)

| File | Purpose |
|------|---------|
| `index.js` | Express server, HTTP/HTTPS boot, WebSocket server, REST APIs, voice routes, direct chat, settings, docs routing, live call routes |
| `openclaw-bridge.js` | OpenClaw gateway RPC v3 WebSocket bridge, event normalization, demo fallback, and fallback recovery retry |
| `session-monitor.js` | Watches OpenClaw session JSONL files so outside-session work appears in Command Center |
| `hermes-session-monitor.js` | Mirrors Hermes session activity into the same CommandCenter event stream/office presence |
| `voice.js` | TTS/STT integrations, ElevenLabs/Fish Audio support, voice resolution |
| `settings.js` | Voice/settings persistence and masking helpers |
| `companions.js` | Companion registry, Codex pet import, animation-map normalization |
| `agents.js` | Agent roster loading, OpenClaw/Hermes source detection, merge logic, and search helpers |
| `update-settings.js` | Persistent updater preferences/state storage |
| `updater.js` | Repo fetch/check/apply logic, diff/commit summaries, restart scheduling, and auto-update loop |
| `api-auth.js` | Auth middleware for `/api/v1` |
| `api-chat-runner.js` | API chat turn runner using OpenClaw CLI |
| `api-session-store.js` | API chat/session persistence |
| `wake-settings.js` | Wake-word settings persistence |
| `wake-transcriber.js` | Wake audio transcription wrapper |
| `wake-keyword-detector.js` | Wake keyword detector wrapper |
| `gemini-live.js` / `gemini-config.js` | Gemini Live call/session integration |
| `live-tasks.js` | Background/live task helper logic |
| `call-session-store.js` | Live call session state |
| `config.js` | Environment/config loader |

### Client (`public/`)

| File | Purpose |
|------|---------|
| `js/app.js` | Browser boot, WebSocket client, event routing, settings UI, Fish playback mode controls, voice/wake/direct-chat glue |
| `js/office.js` | Canvas office renderer: agents, furniture, wandering, huddles, Codex pets, health/weather widgets, bubbles, sounds |
| `js/companions.js` | Companion preview/render helper logic for settings UI |
| `js/direct-chat.js` | Direct chat UI, file/link library UI, chat event handling |
| `js/voice.js` | Client recording/playback, TTS playback, audio controls, playback mode reporting |
| `js/wake.js` | Wake mode browser-side recording/detection flow |
| `js/mascot.js` | Mascot canvas animation and emotion states |
| `js/terminal.js` | Activity Log renderer |
| `css/styles.css` | Layout, settings modals, responsive/kiosk styling, vignette variables |
| `docs/` | Static docs and OpenAPI assets |
| `vendor/picovoice/` | Browser Picovoice/Porcupine vendor scripts |

### Data flow

Voice from Command Center:

```text
Browser tap/record → POST /api/voice/transcribe → STT → openclaw agent CLI
  → WebSocket agent events → Activity Log + Office animation + TTS playback
```

Direct chat:

```text
Direct chat UI → POST /api/chat/direct → openclaw agent CLI
  → saved chat history → WebSocket response → Activity Log + Office + optional TTS
```

Outside OpenClaw / Hermes activity:

```text
OpenClaw session JSONL changes → session-monitor.js
Hermes session activity → hermes-session-monitor.js
  → normalized agent events → WebSocket → Activity Log + Office + speech
```

Companion import:

```text
Codex pet folder/zip → server/companions.js → registry/settings
  → office renderer loads spritesheet → stable animation rows/frames
```

## Environment Variables

See `.env.example` for the full template.

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `0.0.0.0` | Public/UI listener host |
| `PORT` | `3000` | Public/UI listener port |
| `LOCAL_API_ENABLED` | `false` | Enable a separate localhost-only API listener for local programs |
| `LOCAL_API_HOST` | `127.0.0.1` | Local API listener host (keep loopback-only) |
| `LOCAL_API_PORT` | `3001` | Local API listener port for same-machine apps |
| `DEMO_MODE` | `true` | `true` = no gateway needed; `false` = connect to OpenClaw gateway |
| `GATEWAY_URL` | `ws://127.0.0.1:18789` | OpenClaw gateway WebSocket URL |
| `GATEWAY_TOKEN` | — | Gateway auth token, required when `DEMO_MODE=false` |
| `COMMANDCENTER_API_KEY` | — | Required for the public `/api/v1` API listener; local loopback listener can bypass this |
| `OPENAI_API_KEY` | — | Enables OpenAI-backed STT/TTS paths if configured |
| `WEATHER_LOCATION` | `Kingston,Ontario,Canada` | City/region/country for wttr.in weather |
| `BASE_PATH` | — | Optional mount path, e.g. `/commandcenter` |
| `OPENCLAW_BIN` | `openclaw` | Override path/name for the OpenClaw CLI |
| `HERMES_BRIDGE_ENABLED` | `false` | Enable Hermes profile detection and Hermes session bridge integration |
| `HERMES_BIN` | `hermes` | Override path/name for the Hermes CLI |
| `HERMES_AGENT_ID` | `hermes` | Default agent id used for the primary/default Hermes profile |
| `HERMES_AGENT_LABEL` | `Nyxie` | Default display label for the primary/default Hermes profile |
| `HERMES_AGENT_NAME` | `Nyxie` | Default spoken/name field for the primary/default Hermes profile |
| `HERMES_AGENT_MODEL` | — | Optional model label override for the primary/default Hermes profile |

Additional voice/wake credentials are usually configured through the settings UI and stored in the app settings files rather than manually editing `.env`.

The built-in updater also stores its durable toggle/state locally under `data/update-settings.json` and `data/update-state.json` instead of requiring manual `.env` editing.

## Public + local API pattern

If you want CommandCenter reachable at `techexplore.us` **and** callable by trusted local programs without an API key, use the dual-surface setup:

- public/UI listener on `HOST:PORT` (for example `0.0.0.0:3000`)
- local automation listener on `LOCAL_API_HOST:LOCAL_API_PORT` (recommended `127.0.0.1:3001`)
- set `COMMANDCENTER_API_KEY` for the public `/api/v1` listener
- enable `LOCAL_API_ENABLED=true` so same-machine apps can call `http://127.0.0.1:3001/api/v1/*` with no bearer token

Example:

```env
HOST=0.0.0.0
PORT=3000
COMMANDCENTER_API_KEY=replace_me_with_a_real_secret
LOCAL_API_ENABLED=true
LOCAL_API_HOST=127.0.0.1
LOCAL_API_PORT=3001
```

This keeps the public API authenticated while giving local desktop/mobile companion software a frictionless loopback-only control surface.

## Super app integration notes

If your super app runs on the **same machine** as CommandCenter, prefer the local listener:

```text
http://127.0.0.1:<LOCAL_API_PORT>/commandcenter/api/v1
```

If your app is remote, use the public listener instead:

```text
https://your-domain.example/commandcenter/api/v1
```

Recommended integration flow:

1. Call `GET /agents`
2. Read `primaryAgentId`
3. Let the user pick an agent by `id` / `label`
4. Create a session with `POST /sessions`
5. Send messages with either:
   - `POST /sessions/:id/messages`
   - or `POST /chat` if you want the convenience wrapper
6. Optionally use `GET /sessions`, `GET /sessions/:id/messages`, and `GET /sessions/search` for history/search UX

If you want your app to expose whether an agent is backed by OpenClaw or Hermes, use the `source` field from `/agents` instead of trying to infer it from names.

### External client contract: what is most useful

For local desktop/mobile/device clients, the most useful API surface is:

- `GET /agents` — discover agents and read `primaryAgentId`
- `GET /agents/search` — local search UX for picker dialogs
- `POST /sessions` — create a stable chat session for a chosen agent
- `GET /sessions` — list recent sessions
- `GET /sessions/:id` — load session metadata
- `GET /sessions/:id/messages` — read transcript history
- `POST /sessions/:id/messages` — send a normal chat turn
- `POST /sessions/:id/messages/stream` — receive SSE lifecycle events for live UI
- `POST /chat` — convenience wrapper if you do not want to manage session creation yourself
- `GET/POST /voice` and `GET /voice/options` — optional voice resolution/assignment features
- `GET/POST /files*` — attachment/link library support (`GET /files` currently returns `items`, not `files`)

### Stable fields vs presentational fields

Safe fields for external clients to rely on:

- top-level: `primaryAgentId`
- agent: `id`, `label`, `name`, `source`, `bridge`, `workspace`, `model`, `aliases`
- session: `id`, `agent`, `title`, `createdAt`, `updatedAt`, `messageCount`, `lastMessagePreview`, `metadata`
- message: `id`, `role`, `text`, `timestamp`, `meta`

Treat these as presentational and subject to UI-driven changes:

- `color`
- `voice`
- `visual`
- office/presence layout details

### Chat, history, and events

There are two main chat paths:

#### Session-first path

Use this when your client wants explicit control over history/state:

1. `POST /sessions`
2. `POST /sessions/:id/messages`
3. `GET /sessions/:id/messages`
4. optionally `POST /sessions/:id/messages/stream` for SSE updates

#### Convenience path

Use `POST /chat` when you want CommandCenter to create or reuse a session for you with less client-side bookkeeping.

### Streaming / event model

`POST /sessions/:id/messages/stream` returns **Server-Sent Events (SSE)**.

Typical event flow:

- `accepted`
- `thinking`
- `response`
- `audio` (when `audio: true`)
- `done`
- `error`

Important notes:

- provider/runtime failures can emit `error` instead of reaching `response` or `done`
- event order is provider-dependent and should be handled defensively by clients
- this is lifecycle/event streaming, not guaranteed token-by-token model output

This is the best fit for clients that want live UI updates, typing/thinking states, or incremental event forwarding into another WebSocket/app layer.

### Local auth behavior

When `LOCAL_API_ENABLED=true`, same-machine clients can call the local listener without a bearer token.

Recommended local pattern:

```text
http://127.0.0.1:<LOCAL_API_PORT>/commandcenter/api/v1
```

Recommended public/remote pattern:

```text
https://your-domain.example/commandcenter/api/v1
Authorization: Bearer YOUR_COMMANDCENTER_API_KEY
```

If a client can use the local loopback listener, prefer it.

### Realtime WebSocket surface

CommandCenter also exposes a realtime WebSocket endpoint for live status/activity updates:

The WebSocket upgrade must include either the authenticated `cc_auth` UI cookie or `Authorization: Bearer <COMMANDCENTER_API_KEY>`. Browser cookie connections are Origin-checked. Bearer tokens are never accepted in query strings.

```text
ws://127.0.0.1:<PORT>/commandcenter/ws
wss://your-domain.example/commandcenter/ws
```

On connection, the server immediately sends a `status` event describing the current bridge/provider state.

Example initial payload:

```json
{
  "type": "status",
  "data": {
    "connected": true,
    "mode": "live",
    "requestedMode": "live",
    "gatewayUrl": "ws://127.0.0.1:18789",
    "gatewayTokenConfigured": true,
    "gatewayTokenSource": "env",
    "lastError": "",
    "lastAuthError": "",
    "lastFallbackReason": "",
    "configuredDemo": false,
    "voiceEnabled": true
  }
}
```

#### Core event families

Most external/local clients will care about these event groups first:

- `status` — initial connection/provider status snapshot
- `bridge:*` — bridge connectivity changes such as `bridge:connected` and `bridge:disconnected`
- `agent:*` — normalized agent activity such as:
  - `agent:thinking`
  - `agent:responding`
  - `agent:error`
  - `agent:idle`
  - `agent:tool_use`
- `voice:*` — voice/transcription side-channel events
- `live_task:*` — background/live task state updates

There are also richer product-specific event families, especially:

- `call:*` — Fairy/live-call state, transcript, audio, screen/camera, and handoff events
- `agent_comms:*` — internal backchannel/agent-comms events

#### Guidance for external clients

- use REST for roster discovery, sessions, transcripts, files, and voice configuration
- use SSE (`/sessions/:id/messages/stream`) for per-turn lifecycle updates
- use WebSocket (`/ws`) for ambient provider status and live activity/presence updates
- normalize event names into your own internal client model instead of binding your entire app directly to raw CommandCenter event strings

The WebSocket feed is useful, but it is broader and more product-shaped than the core REST chat contract.

### Attachment behavior

Reusable `fileIds` are resolved only through the managed chat-library manifest. Bounded text/source content is inlined, PDFs are extracted with `pdf-parse`, and PNG/JPEG/WebP/GIF images are passed to Hermes through its native `--image` argument. If the chosen OpenClaw or relay CLI has no verified image-input mechanism, the response reports that image as `unsupported` instead of claiming it was inspected. Responses expose per-file `attachmentStatuses` (`consumed`, `truncated`, `unsupported`, or `rejected`).

### Platform and updater safety

Optional Python workers resolve `PYTHON_BIN`, the project virtual environment, the Windows `py -3` launcher, `python3`, then `python`. Missing Python/wake dependencies disable those optional features without terminating the server. Update application remains Linux-only and reports an explicit unsupported capability on Windows; unattended auto-update is opt-in.

## Agent Configuration

### Agent config file

Copy the example to your OpenClaw config directory if you want the bundled example roster/config:

```bash
cp config/openclaw.json.example ~/.openclaw/openclaw.json
```

### System prompts

| Agent | Prompt location |
|-------|----------------|
| Primary/main | `agents/main/SYSTEM.md` → copy/use as appropriate for your OpenClaw setup |
| Orbit/example sub-agent | `agents/claw-1/SYSTEM.md` |
| Nova/example sub-agent | `agents/claw-2/SYSTEM.md` |

Sub-agent prompts are intentionally short and speed-focused.

### Agent self-setup

If your OpenClaw agent can read files, point it at `SETUP.md`. It contains step-by-step setup instructions the agent can follow.

## Companion / Codex Pet Notes

Codex imports expect a package containing a `pet.json` and a spritesheet asset. `spritesheet.webp` is the default, but the importer now also respects the path declared in `spritesheetPath`.

The renderer looks for common animation keys such as:

- `idle`
- `waiting`
- `review`
- `waving` / `wave`
- `jumping` / `jump`
- `failed` / `error`
- `runningRight` / `running-right`
- `runningLeft` / `running-left`
- `walkRight`
- `walkLeft`
- `walkUp`
- `walkDown`

If a key is missing, Command Center falls back to the closest available row so pets do not break.

## Session Architecture & Cross-Channel Awareness

The Command Center has its own UI/session path, but it can now reflect work happening outside the UI through `session-monitor.js`.

This means:

- **Command Center voice/direct chat** still has its own immediate UI flow.
- **Outside conversations/work** can appear in the Activity Log when OpenClaw session files update.
- **Final assistant responses** from outside work can be spoken in Command Center.
- **Long-term memory** remains shared by the underlying OpenClaw setup.

The result: the office feels like a live status board for the agent system, not just a separate toy panel. Shocking. Useful, even.

## Cost Optimization

Running multiple AI agents can get expensive. Suggested practices:

### 1. Use cheaper models for simple sub-agents

For sub-agents that only need to execute simple tasks, use a fast/cheap model and reserve stronger models for the primary orchestrator.

### 2. Keep sub-agent prompts short

Short prompts, short replies, and low/no reasoning for helper agents reduce cost and latency.

### 3. Reset long sessions when needed

Reset or compact long-running sessions before switching task domains or after very large conversations.

### 4. Use the Activity Log as status, not transcript storage

The Activity Log is for live visibility. Long-term continuity should live in memory/session files.

## Raspberry Pi / Kiosk Deployment

### Deploy from local machine

```bash
rsync -avz ./ pi@<PI_IP>:/home/pi/CommandCenter/ \
  --exclude node_modules --exclude .env --exclude .git --exclude data
ssh pi@<PI_IP> 'cd /home/pi/CommandCenter && npm install'
```

### Generate HTTPS certs if needed

```bash
cd /home/pi/CommandCenter
openssl req -x509 -newkey rsa:2048 \
  -keyout server/key.pem \
  -out server/cert.pem \
  -days 365 -nodes \
  -subj '/CN=localhost'
```

### Start / restart

```bash
cd /home/pi/CommandCenter
npm start
```

Or use `start.sh` for kiosk-style launches where applicable.

### Audio notes

Browser playback is handled through Web Audio / normal browser audio output. On kiosk hardware, make sure the OS output device and volume are set before launching Chromium.

## Troubleshooting

### Server won't start — port in use

```bash
fuser -k 3000/tcp
npm start
```

### Gateway connection keeps dropping

Check:

- `DEMO_MODE=false`
- `GATEWAY_URL`
- `GATEWAY_TOKEN`
- gateway reachable from this machine
- RPC v3 handshake support in `server/openclaw-bridge.js`

### Outside responses do not show or speak

Restart Command Center after pulling updates. The outside-response fix lives in server-side `session-monitor.js`, so frontend refresh alone is not enough.

### Voice not working

- Check browser mic permissions.
- Check server logs for voice route errors.
- Configure provider settings in the Settings modal.
- For ElevenLabs, verify API key and voice ID.
- For Fish Audio, verify the AIChat base URL, session cookie, format, and voice/reference ID.

### Wake mode not detecting

- Verify mic permissions.
- Check wake settings.
- For custom wake words, confirm `.ppn` files were uploaded and assigned to the correct agent.
- Try a built-in Porcupine wake word to isolate custom keyword issues.

### Codex pet import fails

- Confirm the package includes `pet.json`.
- Confirm the spritesheet path referenced by the pet metadata exists.
- Try importing from an extracted folder first, then zip once confirmed.

### Codex pet running animation flickers

This build includes the stable walking-row fix. If flicker returns:

- hard refresh the browser
- confirm `app.js` and `office.js` cache-busted versions are current
- inspect the pet's running/walking rows and `frameCounts`

### Weather widget shows wrong location

Set `WEATHER_LOCATION` in `.env` to your city, for example:

```env
WEATHER_LOCATION=Washington,DC,USA
```

## Repository

Current project repo:

```text
https://github.com/EpicIsTheOne/CommandCenter
```
n

Set `WEATHER_LOCATION` in `.env` to your city, for example:

```env
WEATHER_LOCATION=Washington,DC,USA
```

## Repository

Current project repo:

```text
https://github.com/EpicIsTheOne/CommandCenter
```


## LICENSE

[LICENSE_TYPE], see LICENSE file for details.
