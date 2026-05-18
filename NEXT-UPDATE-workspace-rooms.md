# Next Update — Workspace Rooms

Saved for later so we do not burn tokens before the weekend open-source push.

## Context
Current Workspace Rooms work completed:
- persistent room storage via `/api/workspace/rooms`
- add / delete / rename rooms
- move agents between rooms
- room cap = 5 agents
- room nav overlay in office workspace
- room switching now correctly changes visible agents
- room reorder controls added
- subtle room switch transition added

Current known good live split when needed:
- `Main Office` → `orchestrator`, `builder`, `ui`, `anby`
- `Room 2` → `solace`

## Goal for next update
Do a polish pass on Workspace Rooms without rewriting architecture.

## Recommended next feature batch
1. Better room reorder UX polish
2. Optional room tabs / quicker room jumping
3. Small visual polish for transitions / labels
4. Cleanup any temporary debug helpers if no longer needed
5. Final pre-open-source hardening pass on room behavior

## Exact prompt for the next coding pass

Implement Workspace Rooms polish in `/root/.openclaw/workspace/openclaw-command-center`.

Current state:
- Workspace rooms already exist and persist through `/api/workspace/rooms`.
- `server/workspace-rooms.js` handles normalization/persistence.
- `public/js/app.js` manages `workspaceRooms`, `currentWorkspaceRoomId`, room editor, add/delete/rename/move.
- `public/js/office.js` renders only the active room agents.
- Cache bust is currently around `rooms6`.
- A debug hook exists in `office.js`: `window.__commandCenterOfficeDebug`.

Your task:
Add room reordering polish and optional quick-jump UX. Do not rewrite the architecture. Do not change the API shape unless absolutely necessary.

### Goals
1. Make room reordering feel cleaner and more obvious.
2. Add quicker room switching when several rooms exist.
3. Keep current room selected correctly after reorder.
4. Keep nav label/index accurate after reorder.
5. Preserve all existing add/delete/rename/move behavior.

### Requirements

#### 1) Reorder polish
- Keep the existing move left/right controls in each room card.
- Improve their UI clarity if needed.
- After reordering:
  - keep `currentWorkspaceRoomId` bound to the same room id
  - refresh nav, editor, and office view
  - keep agent assignments unchanged
  - keep room names unchanged
- Status text should clearly describe the reorder result.

#### 2) Quick room jump UX
Add one of these lightweight options:
- a compact dropdown in the nav, or
- clickable room tabs/chips, or
- a jump list inside the Workspace Rooms section.

Rules:
- must use the existing room state
- must not replace prev/next nav
- must update `currentWorkspaceRoomId`
- must refresh office view/nav/editor immediately
- if only one room exists, hide or disable the quick-jump UI

#### 3) Transition polish
- Keep room switch transition subtle and fast.
- Improve it only if the result is clearly better.
- Do not make it slow or flashy.
- Must not interfere with click-to-talk.

#### 4) Nav polish
- Keep format: `Room Name • X / Y`
- Ensure it always stays correct after:
  - reorder
  - rename
  - delete
  - add
  - quick jump
- If useful, improve truncation/tooltip behavior for long names.

#### 5) Cleanup / hardening
- Keep `window.__commandCenterOfficeDebug` for now unless explicitly asked to remove it.
- Avoid stale UI states.
- Avoid architectural rewrites.
- Prefer small targeted edits.

#### 6) Cache busting
If frontend files change:
- bump `public/index.html` asset query strings
- bump `office.js` import query in `app.js` if needed
- use a new suffix after `rooms6`

### Validation required
Run:
- `node --check public/js/app.js`
- `node --check public/js/office.js`
- `node --check server/index.js`
- `node --check server/workspace-rooms.js`

### Manual sanity checks
- reordering rooms does not lose/duplicate agents
- quick-jump changes visible room correctly
- room label updates correctly
- selected room remains correct after reorder
- agent assignments remain attached to the correct room ids

### Definition of done
- rooms can still be reordered safely
- quicker room switching exists when multiple rooms are present
- nav stays correct after all room actions
- no regressions in add/delete/rename/move
- syntax checks pass

## Note
Do not spend time on this until after the open-source weekend unless there is spare budget and no active bug pressure.
