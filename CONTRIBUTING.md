# Contributing

Thanks for contributing to Command Center. This is a Linux-first,
security-sensitive project (it can drive agents, place calls, and auto-update
itself), so a few conventions keep the surface safe.

## Development setup

```bash
git clone <your-fork>
cd CommandCenter
npm ci
npm test            # runs the full node:test suite
npm run check:syntax
cp .env.example .env   # edit as needed; see SECURITY.md
npm start             # http://localhost:3000 (operator setup required on first run)
```

> The server binds `0.0.0.0` by default. For local work you usually want it
> behind a reverse proxy or bound to `127.0.0.1`.

## Branching

- `main` is the protected, deployable branch.
- Short-lived feature/fix branches (e.g. `fix/websocket-auth`) are fine.
- Keep PRs focused. One logical change per PR.

## Test discipline (required)

- Every behavioral change ships with a test. We use `node:test` (`test/*.test.js`).
- Run the **full** suite (`npm test`) and the startup smoke
  (`node scripts/startup-smoke.cjs`) before opening a PR.
- The startup smoke boots the real server and verifies the auth matrix
  (setup-gated routes return `403` before setup, anonymous API calls are
  rejected, bearer/local-listener paths work). A green smoke is mandatory for
  auth-related changes.
- If you add an environment variable, document it in `.env.example`.
- If you change server behavior, add or update a test that proves the new
  behavior — not just that it does not crash.

## Security expectations

- **No route may bypass operator authentication.** New `/api/*` browser
  routes must be classified `ui-session` (or stricter) by
  `server/route-policy.js`. The public `/api/v1` surface requires a bearer
  token. When in doubt, require auth.
- Never log secrets. The codebase redacts tokens/keys in logs and git output;
  follow the same pattern.
- Child-process calls and uploads go through existing helpers
  (`server/run-utils.js`, `server/upload-policy.js`). Don't shell out
  ad-hoc with unsanitized input.
- Changing the update flow? Keep the post-restart health gate + rollback
  (`server/updater.js`) intact so a bad update cannot brick the host.

## Commit messages

Concise, imperative, and scoped when helpful:

```
fix: verify UI auth policy runs before the auth router
feat: retention prune for live tasks
security: DEMO_MODE defaults to off
```

## Before you open a PR

- [ ] `npm test` is green
- [ ] `node scripts/startup-smoke.cjs` passes (if auth/routes changed)
- [ ] `npm audit --omit=dev` reports 0 vulnerabilities
- [ ] `.env.example` updated for any new env vars
- [ ] No secrets committed; `SECURITY.md` updated if the threat model changed
