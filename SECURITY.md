# Security Policy

Command Center is a self-hosted dashboard that can drive AI agents, place
calls, play audio, read private memory, and auto-update itself. Treat every
deployment as a privileged host: anyone who reaches the UI can, by design,
trigger real actions.

## Supported versions

Only the latest `main` is supported. Security fixes land on `main` and are
expected to be pulled via the in-app updater (which verifies a healthy
restart before keeping the new code).

## Vulnerability history (this fork)

| Date | Area | Status |
|------|------|--------|
| 2026-07-12 | Unauthenticated `/api/fairy/*`, `/api/call/*`, `/api/live/*` + WebSocket feed | Fixed — routes now behind UI session / bearer auth |
| 2026-07-12 | `npm audit`: 3 high + 3 moderate in production deps | Fixed — `express`/`ws`/`multer`/`qs`/`body-parser`/`path-to-regexp` pinned via overrides |
| 2026-07-12 | Windows startup crash (`spawn python3 ENOENT`) | Mitigated — Python is optional and failure is graceful |
| 2026-07-12 | Default `DEMO_MODE=true` | Fixed — `DEMO_MODE` is `false` by default; demo mode never disables operator auth |

Run `npm audit --omit=dev` before deploying; the supported configuration
reports **0 vulnerabilities**.

## Authentication model

- **Operator setup** is loopback-only (`/api/auth/setup` rejects non-loopback
  requests). Passwords require ≥ 12 characters.
- **Browser UI** uses a session cookie issued at setup/login. Sensitive
  routes (`ui-session` classification) return `403` until setup completes and
  `401` for anonymous callers afterward.
- **Public `/api/v1`** requires a `COMMANDCENTER_API_KEY` bearer token. The
  optional local listener accepts a no-key bypass **only** from a loopback
  peer on the configured local interface.
- **WebSockets** are authorized per-connection; unauthorized frames are
  rejected.
- **DEMO_MODE** changes agent/runtime behavior only. It does **not** weaken
  any of the above.

## Deployment hardening

1. **Do not expose port 3000 directly to the internet.** Put it behind a
   reverse proxy (Caddy / Traefik / nginx) with TLS and, ideally, an
   additional authenticating layer.
2. Set a strong operator password on first setup (loopback).
3. Set `COMMANDCENTER_API_KEY` if you use the `/api/v1` surface.
4. Keep `DEMO_MODE=false` in production.
5. The in-app updater verifies the server boots healthy after a restart and
   rolls back to the previous commit if it does not. Keep `git` available to
   the process so rollback can succeed.
6. Containers: the provided `Dockerfile` runs under `tini` for correct signal
   handling and has a `/api/health` healthcheck. Mount `data/` as a volume so
   state survives container recreation.

## Reporting a vulnerability

Please report security issues **privately** to the maintainer rather than
opening a public issue. Include:

- a description of the impact,
- steps to reproduce (or a proof-of-concept),
- the affected version/commit.

You will receive an acknowledgement and a coordinated disclosure timeline.
Public disclosure should wait until a fixed version is available.
