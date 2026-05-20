import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
const RECORDINGS_DIR = join(DATA_DIR, 'fairy-recordings');
const META_FILE = join(RECORDINGS_DIR, 'recordings.json');

function nowIso() {
  return new Date().toISOString();
}

function sanitizeName(name = '') {
  return String(name || 'recording')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'recording';
}

async function ensureStore() {
  await mkdir(RECORDINGS_DIR, { recursive: true });
  if (!existsSync(META_FILE)) {
    await writeFile(META_FILE, JSON.stringify({ recordings: [] }, null, 2) + '\n');
  }
}

async function loadMeta() {
  await ensureStore();
  try {
    const raw = await readFile(META_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const recordings = Array.isArray(parsed.recordings) ? parsed.recordings : [];
    return { recordings };
  } catch {
    return { recordings: [] };
  }
}

async function saveMeta(meta = { recordings: [] }) {
  await ensureStore();
  await writeFile(META_FILE, JSON.stringify({ recordings: Array.isArray(meta.recordings) ? meta.recordings : [] }, null, 2) + '\n');
}

export async function listFairyRecordings() {
  const meta = await loadMeta();
  return [...meta.recordings].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
}

export async function saveFairyRecording({ buffer, mimeType = 'video/webm', sessionId = '', startedAt = '', endedAt = '', durationMs = 0, includeMic = false, includeFairy = false, notes = '', source = 'fairy-live' } = {}) {
  await ensureStore();
  if (!buffer?.length) throw new Error('Missing recording buffer');
  const ext = extname(String(mimeType).includes('mp4') ? 'recording.mp4' : 'recording.webm') || '.webm';
  const stamp = nowIso().replace(/[:.]/g, '-');
  const safeSession = sanitizeName(sessionId || 'fairy-call');
  const id = `fairy-rec-${randomUUID()}`;
  const filename = `${stamp}-${safeSession}-${id}${ext}`;
  const filePath = join(RECORDINGS_DIR, filename);
  await writeFile(filePath, buffer);
  const info = await stat(filePath);
  const meta = await loadMeta();
  const record = {
    id,
    sessionId: String(sessionId || ''),
    filename,
    mimeType: String(mimeType || 'video/webm'),
    bytes: Number(info.size || buffer.length || 0),
    createdAt: nowIso(),
    startedAt: startedAt || '',
    endedAt: endedAt || '',
    durationMs: Math.max(0, Number(durationMs || 0)),
    includeMic: includeMic === true,
    includeFairy: includeFairy === true,
    notes: String(notes || '').slice(0, 300),
    source: String(source || 'fairy-live'),
  };
  meta.recordings.unshift(record);
  await saveMeta(meta);
  return record;
}

export async function getFairyRecording(id = '') {
  const meta = await loadMeta();
  return meta.recordings.find((item) => item.id === id) || null;
}

export function getFairyRecordingPath(record = {}) {
  if (!record?.filename) return '';
  return join(RECORDINGS_DIR, basename(String(record.filename || 'recording.webm')));
}

export async function cleanupFairyRecordingIndex() {
  const meta = await loadMeta();
  const files = new Set(await readdir(RECORDINGS_DIR).catch(() => []));
  const next = meta.recordings.filter((item) => item?.filename && files.has(item.filename));
  if (next.length !== meta.recordings.length) await saveMeta({ recordings: next });
  return next;
}
