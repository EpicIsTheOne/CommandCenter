# Fairy Live Implementation Plan

A phased implementation checklist for adding **Gemini Live-powered Fairy Mode** to Command Center.

## Product framing

- **Fairy** = realtime voice / screen-aware interface layer
- **Astra / OpenClaw** = execution layer for real work
- **Command Center** = visible UI tying both together

Guiding rule:

> **Fairy talks. Astra acts.**

This feature should make Command Center feel like a living mission desk without replacing the existing OpenClaw agent system.

---

## Phase 0 — Confirm existing backend behavior

### Goal
Verify what already works before changing architecture.

### Tasks
- [ ] Confirm Gemini Live session can start successfully with current backend
- [ ] Confirm Mission Control Gemini config endpoint returns usable config
- [ ] Confirm audio uplink path works end-to-end
- [ ] Confirm response text events are emitted
- [ ] Confirm response audio events are emitted
- [ ] Confirm `handoff_to_openclaw` tool path actually creates tasks
- [ ] Confirm live task updates are broadcast over WebSocket
- [ ] Confirm call session lifecycle is stable:
  - [ ] start
  - [ ] active
  - [ ] end
  - [ ] failure state

### Files to inspect/test
- `server/gemini-live.js`
- `server/gemini-config.js`
- `server/index.js`
- Mission Control endpoint serving `/api/user/gemini-key`

### Deliverable
- Short current-state note listing:
  - what works
  - what is stubbed
  - what breaks

---

## Phase 1 — Reframe Gemini Live as Fairy

### Goal
Convert the hidden live runtime from “Astra live voice” into **Fairy**, a distinct realtime interface persona.

### Tasks
- [ ] Replace Astra-specific live prompt with Fairy-specific system prompt
- [ ] Rename prompt constants to reflect Fairy identity
- [ ] Update live prompt so Fairy:
  - [ ] knows she is the realtime interface
  - [ ] does not claim backend execution
  - [ ] routes real work to Astra/OpenClaw
  - [ ] gives quick summaries, guidance, and screen-aware help
- [ ] Keep `handoff_to_openclaw`, but rewrite tool description to match Fairy’s role
- [ ] Ensure handoff acknowledgements sound like routing, not completion
- [ ] Add explicit role separation language in prompt:
  - [ ] Fairy talks
  - [ ] Astra/OpenClaw acts

### Files
- `server/gemini-live.js`

### Deliverable
- Fairy persona active in Gemini Live sessions

---

## Phase 2 — Improve backend session/event model

### Goal
Make live call state explicit and easy for the frontend to render.

### Tasks
- [ ] Add/standardize call states:
  - [ ] `idle`
  - [ ] `connecting`
  - [ ] `ready`
  - [ ] `listening`
  - [ ] `thinking`
  - [ ] `speaking`
  - [ ] `handing_off`
  - [ ] `task_running`
  - [ ] `error`
  - [ ] `ended`
- [ ] Broadcast explicit state transitions over WebSocket
- [ ] Add clear event types for handoff lifecycle:
  - [ ] `call:handoff.started`
  - [ ] `call:handoff.task_created`
  - [ ] `call:handoff.failed`
- [ ] Link handoff task IDs to call sessions
- [ ] Track screen share state in call session
- [ ] Track mute state in call session if useful
- [ ] Persist enough metadata for frontend refresh recovery
- [ ] Ensure playback completion transitions session back to `ready`

### Likely files
- `server/index.js`
- `server/call-session-store.js`
- `server/live-tasks.js`

### Deliverable
- Clean backend event contract for Fairy Live UI

---

## Phase 3 — Add lightweight runtime context for Fairy

### Goal
Give Fairy enough awareness to be useful without dumping the whole world into every turn.

### Tasks
- [ ] Define a small structured live context snapshot
- [ ] Include data like:
  - [ ] active tasks
  - [ ] recent agent activity summary
  - [ ] current agent states
  - [ ] high-level system health summary
- [ ] Decide when context is injected:
  - [ ] on session start
  - [ ] before direct text turns
  - [ ] before/after handoff
- [ ] Keep context compact and deterministic
- [ ] Avoid raw log spam
- [ ] Ensure context helps answer:
  - [ ] “what’s going on right now?”
  - [ ] “who’s busy?”
  - [ ] “is anything broken?”
  - [ ] “what changed recently?”

### Likely files
- `server/index.js`
- `server/gemini-live.js`
- optional new helper: `server/fairy-context.js`

### Deliverable
- Fairy can give meaningful local summaries during live calls

---

## Phase 4 — Build minimal frontend Fairy Live panel

### Goal
Expose the backend in the actual UI.

### Tasks
- [ ] Add new UI section: **Fairy Live**
- [ ] Add panel markup to page
- [ ] Show current live status
- [ ] Add Start Call button
- [ ] Add End Call button
- [ ] Add transcript area
- [ ] Add Fairy response text area
- [ ] Add handoff/task state area
- [ ] Add error display area
- [ ] Add loading/connecting visuals

### Files
- `public/index.html`
- `public/css/styles.css`

### Deliverable
- Visible Fairy panel in Command Center

---

## Phase 5 — Implement frontend live session client

### Goal
Make the Fairy panel functional.

### Tasks
- [ ] Create dedicated frontend module for Fairy Live
- [ ] Load runtime config from `/api/live/config`
- [ ] Start call with `/api/call/start`
- [ ] End call with `/api/call/:id/end`
- [ ] Subscribe to WebSocket call events
- [ ] Maintain client-side state store for:
  - [ ] session id
  - [ ] status
  - [ ] transcript
  - [ ] response text
  - [ ] current task/handoff
  - [ ] errors
- [ ] Render incoming response text
- [ ] Render call lifecycle changes
- [ ] Render handoff updates
- [ ] Render task completion/failure

### Files
- new: `public/js/fairy-live.js`
- update: `public/js/app.js`

### Deliverable
- UI responds to backend live call events correctly

---

## Phase 6 — Microphone capture + audio uplink

### Goal
Send live microphone audio from browser to Gemini Live backend.

### Tasks
- [ ] Add mic permission flow
- [ ] Capture browser audio stream
- [ ] Convert/encode audio into expected uplink format
- [ ] Chunk audio at a stable interval
- [ ] POST chunks to `/api/call/:id/audio`
- [ ] Handle mute/unmute
- [ ] Stop capture cleanly on call end
- [ ] Show clear mic-live indicator
- [ ] Handle mic permission denial gracefully

### Questions to resolve
- [ ] exact browser-side PCM encoding approach
- [ ] worklet vs script processor
- [ ] chunk size and cadence
- [ ] resampling to 16k if required

### Files
- `public/js/fairy-live.js`

### Deliverable
- User can speak and Fairy receives live audio

---

## Phase 7 — Audio playback for Fairy responses

### Goal
Play Gemini Live response audio smoothly in browser.

### Tasks
- [ ] Accept `call:response.audio` chunks
- [ ] Decode PCM audio stream
- [ ] Queue playback in order
- [ ] Handle streamed chunk timing cleanly
- [ ] Prevent overlapping/broken playback
- [ ] Signal backend when playback finishes:
  - [ ] `assistant.playback_finished`
- [ ] Show speaking animation/state
- [ ] Fall back gracefully if audio playback fails

### Files
- `public/js/fairy-live.js`
- optional helper module if needed

### Deliverable
- Fairy can speak back in realtime, not just text

---

## Phase 8 — Transcript UX

### Goal
Make the interaction feel responsive and understandable.

### Tasks
- [ ] Display partial transcript while user speaks
- [ ] Display final transcript when turn closes
- [ ] Display Fairy live response text as it arrives
- [ ] Distinguish user speech vs Fairy response visually
- [ ] Keep transcript readable and not overly noisy
- [ ] Decide whether transcript is ephemeral or partially persistent
- [ ] Optionally add compact turn history

### Files
- `public/js/fairy-live.js`
- `public/css/styles.css`
- `public/index.html`

### Deliverable
- Good live call readability

---

## Phase 9 — Task handoff UX

### Goal
Make OpenClaw escalation obvious and satisfying.

### Tasks
- [ ] Show visible “Handing off to Astra” state
- [ ] Show created task title
- [ ] Show assigned agent
- [ ] Show task status updates
- [ ] Link handoff status to existing live task updates
- [ ] Show completion summary in Fairy panel
- [ ] Reflect handoff in Activity Log
- [ ] Optionally trigger office visual emphasis when handoff begins

### Files
- `public/js/fairy-live.js`
- `public/js/app.js`
- maybe `public/js/office.js`
- maybe `public/js/terminal.js`
- `server/index.js` for cleaner events

### Deliverable
- User clearly sees the shift from talking to doing

---

## Phase 10 — Optional screen share support

### Goal
Let Fairy see the user’s screen during a live call.

### Tasks
- [ ] Add Share Screen button
- [ ] Use `getDisplayMedia`
- [ ] Capture video frames at a throttled cadence
- [ ] Compress frames to JPEG
- [ ] POST to `/api/call/:id/screen`
- [ ] Show clear screen-sharing-active indicator
- [ ] Stop cleanly on user action or permission loss
- [ ] Handle permission denial gracefully
- [ ] Keep frame rate conservative for v1

### Suggested v1 behavior
- [ ] manual enable only
- [ ] low FPS / interval-based upload
- [ ] no background sharing after call end

### Files
- `public/js/fairy-live.js`
- `public/index.html`
- `public/css/styles.css`

### Deliverable
- Fairy can comment on visible UI/screens during live calls

---

## Phase 11 — Settings / diagnostics

### Goal
Make setup understandable without spelunking through code.

### Tasks
- [ ] Add Fairy Live settings section
- [ ] Show runtime status:
  - [ ] Gemini configured?
  - [ ] model available?
  - [ ] mic ready?
  - [ ] screen share supported?
- [ ] Show current model name
- [ ] Show if Mission Control key is available
- [ ] Add basic debug status text for connection issues
- [ ] Add enable/disable toggle if needed
- [ ] Optionally add “test live connection” button

### Likely files
- `public/index.html`
- `public/js/app.js`
- `public/css/styles.css`

### Deliverable
- Fairy setup can be understood by normal humans

---

## Phase 12 — Kiosk polish

### Goal
Make Fairy feel native to touch-screen / Raspberry Pi Command Center use.

### Tasks
- [ ] Increase touch-friendly control sizing
- [ ] Make start/end actions obvious at a distance
- [ ] Ensure transcript panel scales well on small screens
- [ ] Add idle/active visual states
- [ ] Make call controls resilient to accidental taps
- [ ] Ensure audio routing behaves sensibly on kiosk hardware
- [ ] Optional:
  - [ ] fullscreen live overlay
  - [ ] tap-to-talk-to-Fairy shortcut
  - [ ] room-status summary on activation

### Files
- `public/css/styles.css`
- `public/index.html`
- `public/js/fairy-live.js`

### Deliverable
- Fairy Live feels good on kiosk hardware, not just desktop dev view

---

## Phase 13 — Cleanup / hardening

### Goal
Make the feature shippable.

### Tasks
- [ ] Remove Astra-specific leftover naming in live code
- [ ] Remove confusing dead code / stale debug labels
- [ ] Verify call session cleanup on disconnect
- [ ] Verify no orphan timers/watchdogs remain
- [ ] Verify task handoff failures surface clearly
- [ ] Verify duplicate responses do not spam UI
- [ ] Verify reconnection does not produce broken panel state
- [ ] Document known limitations
- [ ] Update README / docs if feature is exposed publicly

### Files
- touched backend/frontend files
- `README.md`
- maybe `SETUP.md`

### Deliverable
- Stable v1 Fairy Live feature

---

## Recommended file map

### Backend
- `server/gemini-live.js`
  - Fairy prompt/personality
  - tool/handoff semantics
- `server/index.js`
  - event contract
  - live routes integration
  - call state broadcasting
- `server/gemini-config.js`
  - config diagnostics / runtime info
- `server/call-session-store.js`
  - call session state
- `server/live-tasks.js`
  - handoff/task linkage
- optional new file:
  - `server/fairy-context.js`

### Frontend
- `public/index.html`
  - Fairy panel markup
- `public/css/styles.css`
  - Fairy styles
- `public/js/app.js`
  - event integration
- `public/js/fairy-live.js`
  - live client implementation

---

## Recommended build order

1. **Phase 1** — Fairy persona refactor
2. **Phase 2** — backend event/state cleanup
3. **Phase 4–5** — minimal panel + event-driven frontend
4. **Phase 6–7** — mic uplink + response playback
5. **Phase 9** — handoff UX
6. **Phase 10** — screen share
7. **Phase 11–13** — settings, polish, cleanup

This gives a usable feature early instead of spending a century polishing invisible infrastructure.

---

## Suggested first coding slice

### Slice 1
- [ ] Replace Astra live prompt with Fairy
- [ ] Add explicit handoff states/events
- [ ] Create minimal Fairy panel UI
- [ ] Wire start/end session
- [ ] Render text/debug/status only

### Why first
Because it proves:
- the concept is visible
- the backend is actually wired
- the UI contract is sane

before wrestling browser audio streaming demons.

---

## MVP definition of done

- [ ] User can open Command Center and start Fairy Live
- [ ] Fairy visibly connects and responds
- [ ] User can see status + transcripts
- [ ] User can request real work
- [ ] Fairy hands that work to Astra/OpenClaw
- [ ] Task progress appears in UI
- [ ] Identity separation is obvious
- [ ] System feels coherent, not stitched together
