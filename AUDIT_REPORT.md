# Command Center Audit

Audit date: 2026-07-12
Audited commit: `7abf34e` (`main`, matching `origin/main` at clone time)
Audit environment: Windows 11 workstation; the application remains Linux-first by design.

## Executive summary

Command Center has a strong product surface and a surprisingly broad set of integrations, but its security boundary has not kept pace with that surface. The most urgent problems are unauthenticated control/data routes and an unauthenticated WebSocket feed. There is also a confirmed Windows startup crash, a regression in model-readable file attachments, and known vulnerable production dependencies.

The first release after this audit should be a security and reliability release, not another feature release.

## Verification performed

- Fresh clone from `https://github.com/EpicIsTheOne/CommandCenter.git`.
- `npm ci` completed from the committed lockfile.
- `node --check` passed for all 52 JavaScript/CommonJS files.
- `npm audit` reported 6 vulnerabilities: 3 high and 3 moderate.
- `npm run verify:fairy-recording` could not run on Windows because it hardcodes `/usr/bin/chromium`.
- A localhost demo startup was attempted on Windows. The server began listening, then crashed from an unhandled `spawn python3 ENOENT` error.
- Targeted review covered authentication, WebSockets, uploads, chat attachments, child processes, updater behavior, persistence, docs, and Linux/Windows assumptions.

## Findings

### P0 - Sensitive control APIs bypass UI authentication — FIXED

Evidence:

- `server/index.js:420-431` exempts every `/api/fairy/*`, `/api/call/*`, and `/api/live/*` request from UI authentication.
- Those exempt routes include memory read/update/delete (`server/index.js:3265-3297`), recording listing/download (`server/index.js:3340-3362`), call creation and control (`server/index.js:3390-4327`), and live task creation/routing (`server/index.js:4333-4397`).

Impact:

Any network client that can reach the public listener can inspect private Fairy memory and recordings, alter/delete memory, create or manipulate live calls, upload call media, and enqueue prompts for agents without a UI session or API bearer token. Because the default host is `0.0.0.0`, this is commonly reachable beyond localhost.

Recommended fix:

- Remove the three broad prefix exemptions.
- Put browser-facing routes behind the UI session middleware.
- Keep `/api/v1/*` behind bearer/local-listener authentication.
- If a small subset must be public, allowlist individual read-only routes and document why.
- Add route-level authorization tests that enumerate every mutating endpoint.

### P0 - WebSocket broadcasts private runtime activity without authentication — FIXED

Evidence:

- `server/index.js:5094-5107` accepts `/ws` connections without checking the UI session, bearer token, Origin, or listener type.
- `server/index.js:5138-5156` broadcasts all events to every connected client.
- Broadcast payloads include agent responses, tool names/inputs, live task results, call transcripts/debug state, session state, and relay activity.

Impact:

A reachable network client can silently observe agent conversations and operational details. Tool inputs and call/session events may contain secrets, file paths, user text, or other private context.

Recommended fix:

- Use a `noServer` WebSocket server and authenticate the HTTP upgrade before `handleUpgrade`.
- Accept a valid UI session on the public listener or the existing API bearer token for integrations.
- Validate `Origin` for browser sessions.
- Separate public-listener and local-listener socket behavior and add negative tests.

### P1 - Windows startup crashes when `python3` is unavailable — FIXED

Evidence:

- `server/index.js:5228-5238` warms both wake workers unconditionally during startup.
- `server/wake-transcriber.js:33-42` spawns literal `python3` and does not attach a child `error` handler.
- `server/wake-keyword-detector.js:9,28-30` hardcodes the Linux virtualenv path `.venv/bin/python` and likewise lacks an `error` handler.
- The Windows smoke run reached the listening state and then terminated with `Error: spawn python3 ENOENT`, emitted as an unhandled child-process error.

Impact:

The server cannot reliably run on a standard Windows Node/Python install. A missing optional wake dependency kills the entire application instead of disabling wake features gracefully.

Recommended fix:

- Add a cross-platform Python resolver: configurable `PYTHON_BIN`, then Windows `py -3`/`python`, then Unix `python3`/`python`.
- Use `.venv/Scripts/python.exe` on Windows and `.venv/bin/python` on Unix.
- Attach `error` handlers immediately after every `spawn`.
- Warm workers only when their feature is enabled; report unavailable optional features through setup status.
- Add Windows and Linux startup smoke jobs.

### P1 - File attachments are metadata-only, not model-readable context — FIXED

Evidence:

- The API accepts `fileIds` for session/chat messages (`server/index.js:4735-4889`).
- `buildAttachmentContext` (`server/index.js:294-302`) emits only the name, local path, MIME type, and download URL.
- `server/api-chat-runner.js:93-152` places that metadata string into the text prompt. It never reads text/PDF contents and never passes an image argument to Hermes or OpenClaw.

Impact:

Clients receive successful attachment semantics while models generally cannot inspect the attached content. This is especially misleading for PDFs and images and is a regression from the intended attachment behavior.

Recommended fix:

- Restore a bounded server-side attachment bundle.
- Inline allowlisted text formats with byte/token limits.
- Extract PDF text with a maintained library or controlled helper and clearly report extraction failures.
- Pass supported images through the selected backend's real image-input mechanism.
- Reject unsupported types or return per-file capability/status fields instead of pretending all attachments are usable.
- Add text, PDF, PNG, JPEG, unsupported-type, oversize, and multi-file integration tests for both backends.

### P1 - Production dependency tree contains known vulnerabilities — FIXED

Evidence from `npm audit`:

- `ws` is vulnerable to memory exhaustion DoS below 8.21.0 and an uninitialized-memory disclosure below 8.20.1.
- Express's legacy `path-to-regexp` dependency is vulnerable to ReDoS below 0.1.13.
- `form-data` below 4.0.6 has CRLF injection.
- `qs`/`body-parser`/`express` also carry a remotely triggerable DoS advisory.
- Multer 1.x is deprecated and npm explicitly recommends Multer 2.x.

Impact:

Several affected packages sit directly on network and upload boundaries. The unauthenticated WebSocket exposure increases the practical importance of the `ws` DoS advisory.

Recommended fix:

- Update `ws` to at least 8.21.0.
- Update Express within its supported 4.x line first, then evaluate Express 5 separately.
- Update the OpenAI dependency chain that brings the vulnerable `form-data`, or override only after compatibility verification.
- Migrate Multer to 2.x and retest every upload route.
- Make `npm audit --omit=dev` a CI gate for high/critical findings.

### P1 - Login/setup endpoints have no brute-force or setup-race protection — FIXED

Evidence:

- `server/index.js:378-399` exposes password setup and login without rate limiting, lockout/backoff, or request-size-specific controls.
- The initial setup requires only a six-character password.
- The server binds to `0.0.0.0` by default.

Impact:

Login is cheaply brute-forceable. On a fresh network-visible deployment, any client can win the first-password setup race and become the operator.

Recommended fix:

- Bind to loopback by default or require explicit acknowledgement for public binding.
- Restrict first-time setup to loopback or a one-time setup token printed to the console.
- Add IP/session-aware rate limiting and exponential backoff.
- Raise the minimum password length and invalidate all existing sessions after password change.

### P1 - Memory uploads permit excessive aggregate allocation — FIXED

Evidence:

- `server/index.js:82` uses Multer `memoryStorage` with a 10 MB per-file limit.
- Routes accept 10 files normally and up to 500 files for companion folder import (`server/index.js:1740`, `2069`, `3116`).
- There is no aggregate request-size or file-count-aware byte budget beyond the per-file setting.

Impact:

An authenticated request can force hundreds of megabytes or potentially gigabytes of in-memory buffering, causing process termination. The unauthenticated call-recording route adds another memory-backed upload surface.

Recommended fix:

- Stream uploads to a private temporary directory.
- Enforce aggregate byte limits and conservative file counts per route.
- Validate magic bytes/content, not only extensions/MIME strings.
- Clean up partial uploads on every error path.

### P2 - The updater is Linux-only and executes moving remote code automatically — PARTIALLY FIXED

Evidence:

- `server/updater.js:188-207` builds a Bash script using `sleep`, `kill`, `nohup`, and shell redirection.
- `server/updater.js:241-247` runs that script via `bash -lc`.
- Auto-update is enabled by default and the pulled branch is installed and restarted without a signature, release pin, or post-update test gate.

Impact:

The updater cannot work natively on Windows. On Linux, compromise or accidental breakage of the tracked branch becomes automatic code execution on deployed hosts.

Recommended fix:

- Make update apply platform-specific or explicitly label it Linux-only and disable it elsewhere.
- Default auto-update to off for self-hosted production installs.
- Update to a reviewed commit/tag, use `npm ci`, run a health smoke test, and roll back if startup fails.
- Prefer signed releases/checksums over a moving branch for unattended updates.

### P2 - Persistence writes are non-atomic and can lose concurrent updates — PARTIALLY FIXED

Evidence:

- Settings, session indexes, chat history, memory, tasks, and recording metadata are rewritten directly with `writeFile` across the server modules.
- Read-modify-write operations have no shared lock/queue and generally do not write a temporary file followed by atomic rename.

Impact:

Concurrent requests can overwrite each other's changes. A crash or power loss during a write can leave malformed JSON and silently reset stores that use fallback defaults.

Recommended fix:

- Add one JSON-store utility with per-file serialization, temp-file write, fsync where appropriate, and atomic rename.
- Preserve a last-known-good backup and surface corruption instead of silently replacing it with empty state.
- Add concurrent mutation and interrupted-write tests.

### P2 - Test coverage and test portability are too narrow — FIXED

Evidence:

- `package.json` has no general `test`, `lint`, or typecheck script.
- The only verifier covers Fairy recording.
- `scripts/verify-fairy-recording.cjs:73` hardcodes `/usr/bin/chromium`, so the test fails before browser launch on Windows despite Playwright being installed.
- Core server orchestration is concentrated in a roughly 4,900-line `server/index.js`; major browser controllers range from roughly 1,000 to 2,800 lines.

Impact:

Authentication regressions, attachment drift, route-contract mismatches, and platform failures can merge unnoticed. Large files make review boundaries unclear and encourage cross-feature breakage.

Recommended fix:

- Let Playwright resolve its bundled browser, with optional `CHROMIUM_EXECUTABLE_PATH` override.
- Add fast Node tests for auth policy, path/upload validation, JSON stores, and attachment bundling.
- Add Linux + Windows CI for install, syntax, startup health, and unit tests.
- Gradually extract route groups from `server/index.js` behind tested service interfaces.

## Inconsistencies and cleanup

- The product presents a public API and protected UI, but the older internal Fairy/call/live APIs bypass both protection models.
- The API schema accepts attachment IDs, while runtime behavior only forwards metadata.
- Documentation says Node 18+, while the dependency/update policy is not continuously verified against that floor.
- Linux commands and paths appear in setup, updater, health, voice, wake, Hermes monitoring, and the verifier with no centralized platform capability layer.
- The committed `data/` directory mixes distributable sample/media assets with runtime state semantics. Move shipped assets under `public/assets` or `examples`, and keep all mutable state ignored under `data/`.

## Recommended release plan

### Release 1: Security boundary

1. Authenticate WebSocket upgrades.
2. Remove broad API auth exemptions and classify every route as public, UI-session, bearer, or loopback-only.
3. Add login/setup rate limiting and loopback-only first setup.
4. Upgrade `ws`, Express's vulnerable chain, and Multer.
5. Add automated negative authorization tests.

### Release 2: Reliability and portability

1. Add a platform capability module for Python, Bash, ffmpeg, system metrics, and restart behavior.
2. Prevent optional worker failures from killing startup.
3. Make the verifier portable and add Windows/Linux startup CI.
4. Replace memory-backed bulk uploads with streamed, bounded storage.
5. Introduce atomic JSON persistence.

### Release 3: Product correctness

1. Restore real model-readable attachment handling.
2. Generate/validate OpenAPI against route contracts.
3. Split `server/index.js` into authenticated route groups and services.
4. Add retention controls for chat history, recordings, task logs, and call data.

## Suggested new updates

- A setup security screen that clearly reports listener exposure, auth coverage, TLS/proxy state, and whether first-time setup is still open.
- A capability/status endpoint that reports optional dependencies (`python`, `ffmpeg`, Chromium, OpenClaw, Hermes) without crashing startup.
- Per-agent and per-route audit logging for mutating actions, with secret redaction.
- Backup/export/import for settings, memories, chat library, and companion assignments.
- Storage quotas and retention policies visible in Settings.
- A read-only dashboard mode for wall displays, separate from operator/control permissions.
- Health checks suitable for systemd/Docker plus graceful shutdown of workers, WebSockets, timers, and active calls.
- A schema version and migration system for every persisted JSON store.

## Bottom line

## Remediation evidence (2026-07-13)

- P0 route boundary: `server/route-policy.js`, `server/index.js`, and `test/security.test.js` classify public, UI-session, and `/api/v1` bearer/local-listener routes explicitly.
- P0 WebSockets: `server/request-security.js`, the `noServer` upgrade flow in `server/index.js`, and `test/websocket-auth.test.js` cover anonymous/invalid rejection, valid cookie, valid bearer, Origin, and spoofed forwarding headers.
- P1 Windows/optional workers: `server/platform-capabilities.js`, both wake worker wrappers, `server/hermes-session-monitor.js`, `test/platform-capabilities.test.js`, and `test/startup.test.js` cover resolution order and missing-Python startup.
- P1 attachments: `server/attachment-bundle.js`, `server/api-chat-runner.js`, and `test/attachment-bundle.test.js` cover bounded TXT/source/PDF extraction, PNG/JPEG image arguments, unsupported binary files, missing files, traversal, limits, and honest unsupported backend results.
- P1 dependencies/uploads: `package.json`, `package-lock.json`, Multer 2 disk storage in `server/index.js`, `server/upload-policy.js`, and the aggregate-limit test remove the known high/critical production advisories and memory-backed bulk buffering.
- P1 UI authentication: `server/ui-auth.js`, `server/request-security.js`, and auth routes in `server/index.js` implement 12-character passwords, loopback-only setup, generic failures, throttling, session invalidation, and pruning.
- P2 updater (partial): `server/platform-capabilities.js`, `server/updater.js`, and `server/update-settings.js` make apply Linux-only, require a clean tree, use `npm ci` with a lockfile, retain the prior SHA for install rollback, and make auto-update opt-in. A full post-restart health rollback remains future work.
- P2 persistence (partial): `server/json-store.js` plus migrated UI auth, API sessions/index, chat manifest/history, Fairy memory, live tasks, recordings, voice settings, and updater stores provide serialized temp-write/fsync/rename, restrictive modes, backups, and explicit corruption reporting. Lower-risk appearance/branding/layout stores still need migration.
- P2 tests/tooling: `scripts/check-syntax.cjs`, `scripts/startup-smoke.cjs`, portable `scripts/verify-fairy-recording.cjs`, package scripts, and `.github/workflows/ci.yml` cover Windows/Ubuntu and Node 20/22.

The P0 network boundary is now remediated and covered by negative tests. Internet-facing deployments should still use TLS and an authenticating reverse proxy or trusted VPN; the remaining partial P2 updater and lower-risk JSON-store migrations are tracked above.
