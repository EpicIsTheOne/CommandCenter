import { EventEmitter } from 'node:events';
import { RELAY_OWNER_ID, validateDeviceEnvelope } from './relay-protocol.js';
import { authenticateDevice, enrollWithPairing } from './relay-store.js';
import { parseRelayMessage } from './relay-protocol.js';

export const RELAY_STALE_AFTER_MS = 30_000;
export const RELAY_AUTH_ATTEMPT_WINDOW_MS = 60_000;
export const RELAY_AUTH_ATTEMPT_LIMIT = 5;

export class RelayManager extends EventEmitter {
  constructor({ authenticateDeviceFn = authenticateDevice, enrollWithPairingFn = enrollWithPairing } = {}) {
    super();
    this.connections = new Map();
    this.presence = new Map();
    this.sequences = new Map();
    this.lastSequences = new Map();
    this.authAttempts = new Map();
    this.authenticateDeviceFn = authenticateDeviceFn;
    this.enrollWithPairingFn = enrollWithPairingFn;
  }
  async authenticate(ws, auth, peerKey = 'unknown') {
    const now = Date.now();
    const recent = (this.authAttempts.get(peerKey) || []).filter((stamp) => now - stamp < RELAY_AUTH_ATTEMPT_WINDOW_MS);
    if (recent.length >= RELAY_AUTH_ATTEMPT_LIMIT) return null;
    recent.push(now);
    this.authAttempts.set(peerKey, recent);
    const device = auth.payload.method === 'pairing'
      ? await this.enrollWithPairingFn(auth.payload.secret, auth.payload.device)
      : { device: await this.authenticateDeviceFn(auth.payload.secret, auth.payload.deviceId) };
    if (!device?.device) return null;
    this.authAttempts.delete(peerKey);
    const record = device.device;
    this.lastSequences.delete(record.id);
    const prior = this.connections.get(record.id);
    if (prior && prior !== ws) { try { prior.close(4002, 'Replaced by a newer connection'); } catch {} }
    this.connections.set(record.id, ws);
    this.presence.set(record.id, { ownerId: record.ownerId, deviceId: record.id, state: 'online', connectedAt: Date.now(), lastHeartbeatAt: Date.now() });
    this.emit('connected', this.presence.get(record.id));
    return { ...device, device: record };
  }
  handle(ws, raw, deviceId) {
    const parsed = raw && typeof raw === 'object' && !Buffer.isBuffer(raw) ? raw : parseRelayMessage(raw);
    const message = validateDeviceEnvelope(parsed, { deviceId });
    if (message.id && this.sequences.get(deviceId)?.has(message.id)) { const error = new Error('Message was already processed.'); error.code = 'REPLAYED_MESSAGE'; throw error; }
    if (message.type === 'relay.heartbeat' && message.payload.sequence !== undefined && message.payload.sequence <= (this.lastSequences.get(deviceId) ?? -1)) { const error = new Error('Message sequence was already processed.'); error.code = 'REPLAYED_MESSAGE'; throw error; }
    if (!this.sequences.has(deviceId)) this.sequences.set(deviceId, new Set());
    this.sequences.get(deviceId).add(message.id);
    if (message.type === 'relay.heartbeat' && message.payload.sequence !== undefined) this.lastSequences.set(deviceId, message.payload.sequence);
    if (this.sequences.get(deviceId).size > 1000) this.sequences.get(deviceId).delete(this.sequences.get(deviceId).values().next().value);
    if (message.type === 'relay.heartbeat') this.presence.set(deviceId, { ...(this.presence.get(deviceId) || {}), state: 'online', lastHeartbeatAt: Date.now() });
    if (message.type === 'relay.presence') this.presence.set(deviceId, { ...(this.presence.get(deviceId) || {}), state: String(message.payload.state || 'online').slice(0, 40), lastHeartbeatAt: Date.now() });
    if (message.type === 'relay.disconnect') this.presence.set(deviceId, { ...(this.presence.get(deviceId) || {}), state: 'offline', disconnectedAt: Date.now() });
    this.emit('message', { ...message, ownerId: RELAY_OWNER_ID, deviceId });
    return message;
  }
  disconnect(ws, deviceId) {
    if (this.connections.get(deviceId) !== ws) return;
    this.connections.delete(deviceId);
    this.presence.set(deviceId, { ...(this.presence.get(deviceId) || {}), state: 'offline', disconnectedAt: Date.now() });
    this.emit('disconnected', this.presence.get(deviceId));
  }
  listPresence(now = Date.now()) { return [...this.presence.values()].map((entry) => ({ ...entry, state: entry.state === 'online' && now - Number(entry.lastHeartbeatAt || 0) > RELAY_STALE_AFTER_MS ? 'stale' : entry.state })); }
  closeDevice(deviceId, code = 4003, reason = 'Device closed') { const ws = this.connections.get(deviceId); if (!ws) return false; try { ws.close(code, reason); } catch {} return true; }
  send(deviceId, message) { const ws = this.connections.get(deviceId); if (!ws || ws.readyState !== 1) return false; ws.send(JSON.stringify(message)); return true; }
}
