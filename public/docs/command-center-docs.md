# OpenClaw Command Center — Living Docs

## What changed in this build
- **Fairy Live text-turn fix**: Fairy live calls no longer get stuck in `thinking` with an empty `lastAssistantText`. Gemini live text turns now use the proper `clientContent.turns` user-turn shape, and server-side transcript parsing now preserves `outputTranscription.text` even when audio/model output arrives in the same packet.
- **Fairy/OpenClaw voice ownership fix**: Normal Command Center agent TTS is suppressed/interrupted while a Fairy live call is active, so Fairy can speak without the standard agent voice talking over her.
- **Fairy local memory/runtime upgrades**: Fairy runtime config, memory lookup, and call session inspection are exposed through auth-protected `/api/v1/fairy/*` routes and reflected in the bundled docs.
- **Fairy camera support**: Fairy can now receive webcam frames using the same visual uplink path already used for screen sharing. The UI includes `START CAMERA` / `STOP CAMERA`, a header status button, front/back camera switching on supported mobile devices, and a tiny in-panel live camera preview.
- **Mobile header cleanup**: The terminal header action strip now wraps more cleanly on smaller screens so the connection badge, wake mode, Fairy call controls, and settings button do not compress as badly.
- **Install as app / PWA support**: Command Center now ships a `manifest.webmanifest`, a lightweight `sw.js`, and a Settings entry for installing the app from supported browsers. iPhone/iPad users still use Safari’s Share → Add to Home Screen flow.
- **Caching bump**: frontend assets were bumped again so browsers pick up the new Fairy/camera/PWA UI instead of clinging to stale bundles like tiny cache goblins.

## How to run this snapshot
1. `git status` to ensure the working tree is clean aside from intentional source/docs changes.
2. `npm ci` (or `npm install` once) if dependencies need to be restored.
3. `npm start` to launch the server on `http://localhost:3000` (or your configured `PORT` / `BASE_PATH`).
4. Hard-refresh the browser after deploy so the latest cache-busted frontend and PWA assets load.

## Notes for verification
- Start a Fairy call and confirm the call reaches `ready`.
- Send a text turn and verify `lastAssistantText` updates correctly.
- Start Fairy camera sharing and confirm:
  - the tiny preview appears
  - front/back camera switching works on supported mobile devices
  - Fairy still receives frames through the live session
- Open Settings and check the new **Install App** section.
- In supported browsers, confirm the install prompt can be triggered; on iOS Safari, confirm the fallback guidance is visible.

## What to document next
- A small UI-facing Fairy Live guide with screenshots for mic/screen/camera/PWA install flows.
- A deeper protocol note for the live Gemini packet parsing path.
- A deployment note for PWA/browser support expectations across Chrome, Edge, Android, and iOS Safari.
