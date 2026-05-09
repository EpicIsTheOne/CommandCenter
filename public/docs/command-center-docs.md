# OpenClaw Command Center — Living Docs

## What changed in this build
- **Mood-driven office**: Agents now adopt weighted moods (`focused`, `restless`, `curious`, `social`, `tired`, `chaotic`) that alter wander timers and destination weights. They avoid repeating the same action too often.
- **Micro-actions on idle**: Idle agents can twitch, shift position, look up, or briefly show random thoughts instead of a static posture.
- **Rarer, more natural huddles**: Round-table meetups only trigger ~38% of the time once the cooldown expires, use randomized topics from an expanded pool, and sprinkle in randomized topic lines during each meeting.
- **Codex pet ambient animations**: Imported Codex pets can now periodically display `waiting`, `review`, `waving`, `jumping`, and `failed` animations while idle to keep them feeling alive.
- **Caching bump**: `office.js`, `app.js`, and the HTML entry point now use new cache-busted versions so the browser sees the updates immediately.

## How to run this snapshot
1. `git status` to ensure working tree is clean (aside from intentional docs).` 
2. `npm ci` (or `npm install` once) to rebuild dependencies if needed.
3. `npm start` to launch the server on http://localhost:3000 (or set `PORT` via `.env`).
4. Point a browser at the URL and hard-refresh (Ctrl/Cmd+Shift+R) so the new cache-busted assets load.

## Recommended GitHub steps
```bash
# from repo root
git add public/docs/command-center-docs.md public/js/app.js public/js/office.js public/index.html
git commit -am "docs: capture latest command center snapshot"
git push origin main
```
If you want to include the rest of the workspace changes, run `git add -A` before committing.

## What to document next
- API endpoints exposed by the server (`start.sh`, `/api/voice/transcribe`, `/api/settings/voice`).
- Companion import workflow (zip upload, pet.json schema).
- Voice setup steps (ElevenLabs vs Fish Audio) now that the UI has new modals.
- Codex companion animation hints (row map, frame counts, ambient state logic).
