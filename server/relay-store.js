import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { readJsonStore, updateJsonStore } from './json-store.js';
import { RELAY_OWNER_ID, redactRelayAudit } from './relay-protocol.js';

const ROOT = String(process.env.COMMANDCENTER_DATA_DIR || '').trim() || join(process.cwd(), 'data');
const PAIRINGS_FILE = join(ROOT, 'relay-pairings.json');
const DEVICES_FILE = join(ROOT, 'relay-devices.json');
const AUDIT_FILE = join(ROOT, 'relay-audit.json');
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const CREDENTIAL_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const AUDIT_LIMIT = 500;

function hashSecret(secret, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(String(secret), salt, 32).toString('hex')}`;
}
function matches(secret, stored) {
  const [salt, hex] = String(stored || '').split(':');
  if (!salt || !hex) return false;
  const actual = scryptSync(String(secret), salt, 32);
  const expected = Buffer.from(hex, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function id(prefix) { return `${prefix}_${randomBytes(12).toString('hex')}`; }
function code() { return `ccp_${randomBytes(32).toString('base64url')}`; }
function cleanMetadata(device = {}) {
  return { name: String(device.name || device.label || 'Device').slice(0, 120), platform: String(device.platform || device.type || '').slice(0, 80), version: String(device.version || '').slice(0, 80) };
}
function baseStore() { return { schemaVersion: 1, ownerId: RELAY_OWNER_ID }; }
function owned(record) { return record?.ownerId === RELAY_OWNER_ID; }

async function load(file, fallback) { return readJsonStore(file, { defaultValue: fallback }); }
async function audit(event, fields = {}) {
  const safe = redactRelayAudit({ id: id('audit'), ownerId: RELAY_OWNER_ID, event, timestamp: new Date().toISOString(), ...fields });
  await updateJsonStore(AUDIT_FILE, { defaultValue: { ...baseStore(), entries: [] } }, (store) => ({ ...baseStore(), entries: [...(store.entries || []), safe].slice(-AUDIT_LIMIT) }));
}

export async function createPairing({ ttlMs = PAIRING_TTL_MS } = {}) {
  const pairingCode = code();
  const record = { id: id('pair'), ownerId: RELAY_OWNER_ID, codeHash: hashSecret(pairingCode), createdAt: Date.now(), expiresAt: Date.now() + Math.min(Math.max(ttlMs, 1000), PAIRING_TTL_MS), usedAt: null };
  await updateJsonStore(PAIRINGS_FILE, { defaultValue: { ...baseStore(), items: [] } }, (store) => {
    const now = Date.now();
    const items = (store.items || []).filter((item) => !owned(item) || (item.expiresAt > now && !item.usedAt));
    return { ...baseStore(), items: [...items, record] };
  });
  await audit('pairing.created', { pairingId: record.id });
  return { id: record.id, ownerId: RELAY_OWNER_ID, expiresAt: new Date(record.expiresAt).toISOString(), pairingCode };
}

export async function enrollWithPairing(pairingCode, device = {}) {
  let result = null;
  let deviceRecord = null;
  await updateJsonStore(PAIRINGS_FILE, { defaultValue: { ...baseStore(), items: [] } }, (store) => {
    const item = (store.items || []).find((entry) => owned(entry) && !entry.usedAt && entry.expiresAt > Date.now() && matches(pairingCode, entry.codeHash));
    if (!item) return store;
    const deviceId = id('device');
    const credential = `ccr_${randomBytes(32).toString('base64url')}`;
    const now = Date.now();
    deviceRecord = { id: deviceId, ownerId: RELAY_OWNER_ID, credentialHash: hashSecret(credential), createdAt: now, lastSeenAt: null, revokedAt: null, expiresAt: now + CREDENTIAL_TTL_MS, metadata: cleanMetadata(device) };
    item.usedAt = now;
    item.usedDeviceId = deviceId;
    result = { device: publicDevice(deviceRecord), credential };
    return { ...baseStore(), items: store.items || [] };
  });
  if (deviceRecord) {
    await updateJsonStore(DEVICES_FILE, { defaultValue: { ...baseStore(), items: [] } }, (devices) => ({ ...baseStore(), items: [...(devices.items || []), deviceRecord] }));
  }
  await audit(result ? 'device.enrolled' : 'pairing.rejected', result ? { deviceId: result.device.id } : {});
  return result;
}

export async function authenticateDevice(credential, requestedDeviceId = '') {
  const store = await load(DEVICES_FILE, { ...baseStore(), items: [] });
  const item = (store.items || []).find((entry) => owned(entry) && matches(credential, entry.credentialHash) && !entry.revokedAt && entry.expiresAt > Date.now() && (!requestedDeviceId || requestedDeviceId === entry.id));
  if (!item) return null;
  await updateJsonStore(DEVICES_FILE, { defaultValue: { ...baseStore(), items: [] } }, (current) => ({ ...baseStore(), items: (current.items || []).map((entry) => entry.id === item.id ? { ...entry, lastSeenAt: Date.now() } : entry) }));
  await audit('device.authenticated', { deviceId: item.id });
  return publicDevice(item);
}

export async function listDevices() { const store = await load(DEVICES_FILE, { ...baseStore(), items: [] }); return (store.items || []).filter(owned).map(publicDevice); }
export async function revokeDevice(deviceId) {
  let changed = false;
  await updateJsonStore(DEVICES_FILE, { defaultValue: { ...baseStore(), items: [] } }, (store) => ({ ...baseStore(), items: (store.items || []).map((item) => owned(item) && item.id === deviceId && !item.revokedAt ? (changed = true, { ...item, revokedAt: Date.now() }) : item) }));
  if (changed) await audit('device.revoked', { deviceId });
  return changed;
}
export function publicDevice(item) { return { id: item.id, ownerId: RELAY_OWNER_ID, createdAt: item.createdAt, lastSeenAt: item.lastSeenAt, revokedAt: item.revokedAt, expiresAt: item.expiresAt, metadata: item.metadata }; }
export const relayStorePaths = { PAIRINGS_FILE, DEVICES_FILE, AUDIT_FILE };
