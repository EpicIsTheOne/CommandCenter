import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SETTINGS_FILE = join(ROOT, 'data', 'agent-workspace-rooms.json');
const DEFAULT_ROOM_SIZE = 5;

const DEFAULTS = {
  version: 1,
  roomSize: DEFAULT_ROOM_SIZE,
  rooms: [],
};

function uniq(items = []) {
  return [...new Set((Array.isArray(items) ? items : []).map((v) => String(v || '').trim()).filter(Boolean))];
}

function safeRoomName(name, index) {
  const text = String(name || '').trim().slice(0, 60);
  if (text) return text;
  if (index === 0) return 'Main Office';
  return `Room ${index + 1}`;
}

function safeRoomId(id, index) {
  const text = String(id || '').trim().slice(0, 80);
  return text || `room-${index + 1}`;
}

function rosterAgentIds(roster = { agents: [] }) {
  return (roster.agents || []).map((a) => a.id).filter(Boolean);
}

function buildRoomsFromRoster(roster = { agents: [] }, roomSize = DEFAULT_ROOM_SIZE) {
  const ids = rosterAgentIds(roster);
  const rooms = [];
  for (let i = 0; i < ids.length; i += roomSize) {
    const index = Math.floor(i / roomSize);
    rooms.push({
      id: `room-${index + 1}`,
      name: safeRoomName(index === 0 ? 'Main Office' : '', index),
      agentIds: ids.slice(i, i + roomSize),
    });
  }
  if (!rooms.length) rooms.push({ id: 'room-1', name: 'Main Office', agentIds: [] });
  return rooms;
}

export function buildDefaultRooms(roster = { agents: [] }, roomSize = DEFAULT_ROOM_SIZE) {
  return { version: 1, roomSize, rooms: buildRoomsFromRoster(roster, roomSize) };
}

export function normalizeWorkspaceRooms(input = {}, roster = { agents: [] }) {
  const roomSize = Math.max(1, Math.min(5, Number(input.roomSize) || DEFAULT_ROOM_SIZE));
  const validIds = new Set(rosterAgentIds(roster));
  const seen = new Set();
  const normalized = [];
  const sourceRooms = Array.isArray(input.rooms) ? input.rooms : [];

  sourceRooms.forEach((room, idx) => {
    const id = safeRoomId(room?.id, idx);
    const name = safeRoomName(room?.name, idx);
    const picked = [];
    for (const aid of uniq(room?.agentIds || [])) {
      if (!validIds.has(aid) || seen.has(aid)) continue;
      picked.push(aid);
      seen.add(aid);
      if (picked.length >= roomSize) break;
    }
    normalized.push({ id, name, agentIds: picked });
  });

  const missing = rosterAgentIds(roster).filter((id) => !seen.has(id));
  for (const aid of missing) {
    let target = normalized.find((r) => r.agentIds.length < roomSize);
    if (!target) {
      const idx = normalized.length;
      target = { id: `room-${idx + 1}`, name: safeRoomName('', idx), agentIds: [] };
      normalized.push(target);
    }
    target.agentIds.push(aid);
    seen.add(aid);
  }

  if (!normalized.length) return buildDefaultRooms(roster, roomSize);

  const rooms = normalized.map((room, idx) => ({
    id: safeRoomId(room.id, idx),
    name: safeRoomName(room.name, idx),
    agentIds: uniq(room.agentIds).filter((id) => validIds.has(id)).slice(0, roomSize),
  }));

  return { version: 1, roomSize, rooms };
}

export async function loadWorkspaceRooms(roster = { agents: [] }) {
  try {
    if (!existsSync(SETTINGS_FILE)) return buildDefaultRooms(roster);
    const raw = await readFile(SETTINGS_FILE, 'utf8');
    return normalizeWorkspaceRooms(JSON.parse(raw), roster);
  } catch {
    return buildDefaultRooms(roster);
  }
}

export async function saveWorkspaceRooms(input = {}, roster = { agents: [] }) {
  const settings = normalizeWorkspaceRooms(input, roster);
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  return settings;
}
