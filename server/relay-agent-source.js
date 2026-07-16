import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const REQUEST_TIMEOUT_MS = 120000;

function cleanText(value = '') {
  return String(value || '').trim();
}

function slug(value = '') {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
}

function relayAgentId(deviceId = '', providerId = '', agentId = '') {
  return `relay:${slug(deviceId)}:${slug(providerId)}:${slug(agentId)}`;
}

function buildRelayAppUrl(input = '') {
  const raw = cleanText(input);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    else if (url.protocol === 'https:') url.protocol = 'wss:';
    if (!/^wss?:$/.test(url.protocol)) return '';
    if (url.pathname === '/' || !url.pathname) {
      url.pathname = '/v1/app';
    } else if (/\/v1\/device\/?$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/v1\/device\/?$/i, '/v1/app');
    } else if (!/\/v1\/app\/?$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/+$/g, '') + '/v1/app';
    }
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function pickDeviceLabel(device = {}) {
  return cleanText(device.name) || cleanText(device.label) || cleanText(device.id) || 'Remote Device';
}

function normalizeAgentRecord(agent = {}, index = 0) {
  const id = cleanText(agent.id || agent.agentId || agent.name);
  if (!id) return null;
  const label = cleanText(agent.label || agent.name || id);
  return {
    id,
    label,
    name: cleanText(agent.name || label) || label,
    model: cleanText(agent.model),
    index,
    raw: agent,
  };
}

function buildVirtualAgent(device = {}, provider = {}, agent = {}, index = 0) {
  const remoteAgentId = cleanText(agent.id || agent.agentId || agent.name);
  if (!remoteAgentId) return null;
  const providerId = cleanText(provider.id || provider.providerId || provider.kind || provider.name) || 'provider';
  const deviceId = cleanText(device.id) || 'device';
  const label = cleanText(agent.label || agent.name || remoteAgentId) || remoteAgentId;
  const deviceLabel = pickDeviceLabel(device);
  return {
    id: relayAgentId(deviceId, providerId, remoteAgentId),
    label,
    name: cleanText(agent.name || label) || label,
    color: '#7EE7FF',
    voice: 'nova',
    isBoss: false,
    workspace: null,
    model: cleanText(agent.model) || cleanText(provider.model) || null,
    aliases: Array.from(new Set([
      relayAgentId(deviceId, providerId, remoteAgentId),
      remoteAgentId,
      label,
      cleanText(agent.name),
      `${label} ${deviceLabel}`,
      `${remoteAgentId} ${deviceLabel}`,
    ].filter(Boolean))),
    bridge: 'relay',
    source: 'relay',
    relay: true,
    relayDeviceId: deviceId,
    relayDeviceName: deviceLabel,
    relayProviderId: providerId,
    relayProviderLabel: cleanText(provider.label || provider.name || provider.kind || providerId) || providerId,
    relayAgentId: remoteAgentId,
    relayAgentLabel: label,
    relayPlatform: cleanText(device.type || device.platform || ''),
    deviceLabel,
    subtitle: `Relay · ${deviceLabel}`,
  };
}

function mapActivityStatus(status = '') {
  const value = cleanText(status).toLowerCase();
  if (value === 'thinking') return 'agent:thinking';
  if (value === 'responding' || value === 'response') return 'agent:responding';
  if (value === 'tool_use' || value === 'tool_call') return 'agent:tool_use';
  if (value === 'error') return 'agent:error';
  if (value === 'idle') return 'agent:idle';
  return 'agent:thinking';
}

export class RelayAgentSource extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.enabled = false;
    this.url = '';
    this.connected = false;
    this.reconnectDelay = 1500;
    this.devices = new Map();
    this.pending = new Map();
    this.reconnectTimer = null;
    this.lastRosterSignature = '';
  }

  async configure(settings = {}) {
    const enabled = settings?.relayEnabled === true;
    const url = buildRelayAppUrl(settings?.relayUrl || '');
    const changed = enabled !== this.enabled || url !== this.url;
    this.enabled = enabled;
    this.url = url;
    if (!this.enabled || !this.url) {
      this.stop();
      this.emitRosterUpdated(true);
      return this.getStatus();
    }
    if (changed || !this.ws) this.connect();
    return this.getStatus();
  }

  stop() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connected = false;
    this.lastRosterSignature = '';
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Relay connection stopped.'));
    }
    this.pending.clear();
  }

  connect() {
    this.stop();
    if (!this.enabled || !this.url) return;
    this.ws = new WebSocket(this.url);
    this.ws.on('open', () => {
      this.connected = true;
      this.reconnectDelay = 1500;
      this.emit('connected', this.getStatus());
    });
    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw || '{}'));
        this.handleMessage(msg);
      } catch {}
    });
    this.ws.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.emit('disconnected', { ...this.getStatus(), wasConnected });
      this.scheduleReconnect();
    });
    this.ws.on('error', (error) => {
      this.emit('error', error instanceof Error ? error : new Error(String(error || 'Relay socket error')));
    });
  }

  scheduleReconnect() {
    if (!this.enabled || !this.url) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  getStatus() {
    return {
      enabled: this.enabled,
      url: this.url,
      connected: this.connected,
      deviceCount: this.devices.size,
      agentCount: this.getAgents().length,
    };
  }

  getAgents() {
    if (!this.enabled) return [];
    const agents = [];
    for (const record of this.devices.values()) {
      const providers = Array.isArray(record.providers) ? record.providers : [];
      const roster = Array.isArray(record.roster) ? record.roster : [];
      const chosenProviderId = cleanText(record.activeProviderId) || cleanText(providers[0]?.id || providers[0]?.kind || providers[0]?.name);
      const activeProvider = providers.find((provider) => cleanText(provider.id || provider.kind || provider.name) === chosenProviderId) || providers[0] || { id: chosenProviderId || 'provider' };
      const rawAgents = roster.length ? roster : (Array.isArray(activeProvider?.agents) ? activeProvider.agents : []);
      rawAgents.forEach((item, index) => {
        const normalized = normalizeAgentRecord(item, index);
        if (!normalized) return;
        const virtual = buildVirtualAgent(record.device, activeProvider, normalized, index);
        if (virtual) agents.push(virtual);
      });
    }
    return agents;
  }

  getAgent(agentId = '') {
    const needle = cleanText(agentId);
    if (!needle) return null;
    return this.getAgents().find((agent) => agent.id === needle) || null;
  }

  buildSessionMetadata(agentId = '') {
    const agent = this.getAgent(agentId);
    if (!agent) return {};
    return {
      relay: true,
      relayDeviceId: agent.relayDeviceId,
      relayDeviceName: agent.relayDeviceName,
      relayProviderId: agent.relayProviderId,
      relayProviderLabel: agent.relayProviderLabel,
      relayAgentId: agent.relayAgentId,
      relayAgentLabel: agent.relayAgentLabel,
      relayPlatform: agent.relayPlatform,
      relayVirtualAgentId: agent.id,
      chatTransport: 'relay',
    };
  }

  isRelaySession(session = {}) {
    return session?.metadata?.chatTransport === 'relay' || session?.metadata?.relay === true || !!this.getAgent(session?.agent || '');
  }

  async runRelayChatTurn({ session, latestMessage, onEvent } = {}) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Relay is not connected.');
    const metadata = session?.metadata || {};
    const deviceId = cleanText(metadata.relayDeviceId);
    const providerId = cleanText(metadata.relayProviderId) || 'openclaw';
    const remoteAgentId = cleanText(metadata.relayAgentId || metadata.relayAgentLabel || session?.agent);
    const virtualAgentId = cleanText(metadata.relayVirtualAgentId || session?.agent);
    if (!deviceId) throw new Error('Relay session is missing relayDeviceId.');
    if (!remoteAgentId) throw new Error('Relay session is missing relayAgentId.');

    const requestId = `cc_relay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const providerSessionId = cleanText(metadata.relayProviderSessionId);
    const remoteSessionId = cleanText(metadata.relayRemoteSessionId);

    const request = {
      v: 1,
      id: requestId,
      type: 'agent.chat.request',
      timestamp: new Date().toISOString(),
      source: { kind: 'app', id: 'openclaw-command-center' },
      target: { kind: 'device', id: deviceId },
      deviceId,
      payload: {
        providerId,
        agent: remoteAgentId,
        ...(remoteSessionId ? { sessionId: remoteSessionId } : {}),
        ...(providerSessionId ? { providerSessionId } : {}),
        message: cleanText(latestMessage),
      },
    };

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Relay chat request timed out.'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, {
        requestId,
        sessionId: cleanText(session?.id),
        virtualAgentId,
        deviceId,
        providerId,
        remoteAgentId,
        deviceName: cleanText(metadata.relayDeviceName),
        platform: cleanText(metadata.relayPlatform),
        onEvent,
        resolve: (value) => {
          clearTimeout(timer);
          this.pending.delete(requestId);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.pending.delete(requestId);
          reject(error);
        },
        timer,
      });
      this.ws.send(JSON.stringify(request));
    });
  }

  handleMessage(message = {}) {
    const type = cleanText(message.type);
    if (!type) return;
    if (type === 'device.state.snapshot') {
      this.ingestDeviceSnapshot(message);
      this.emitRosterUpdated();
      return;
    }
    if (type === 'agent.roster.snapshot') {
      this.ingestRosterSnapshot(message);
      this.emitRosterUpdated();
      return;
    }
    if (type === 'agent.activity') {
      this.handleActivity(message);
      return;
    }
    if (type === 'agent.chat.response') {
      this.handleResponse(message);
      return;
    }
    if (type === 'command.rejected' || type === 'command.failed') {
      this.handleCommandFailure(message);
    }
  }

  emitRosterUpdated(force = false) {
    const agents = this.getAgents();
    const signature = JSON.stringify({
      status: this.getStatus(),
      agents: agents.map((agent) => ({
        id: agent.id,
        device: agent.relayDeviceId,
        provider: agent.relayProviderId,
        remote: agent.relayAgentId,
        label: agent.label,
      })),
    });
    if (!force && signature === this.lastRosterSignature) return;
    this.lastRosterSignature = signature;
    this.emit('roster-updated', { agents, status: this.getStatus() });
  }

  ensureDevice(deviceId = '') {
    const id = cleanText(deviceId);
    if (!id) return null;
    if (!this.devices.has(id)) {
      this.devices.set(id, {
        device: { id, name: id },
        providers: [],
        roster: [],
        activeProviderId: '',
      });
    }
    return this.devices.get(id);
  }

  ingestDeviceSnapshot(message = {}) {
    const payload = message.payload || {};
    const device = payload.device || {};
    const deviceId = cleanText(message.deviceId || payload.deviceId || device.id);
    const record = this.ensureDevice(deviceId);
    if (!record) return;
    record.device = { ...record.device, ...device, id: deviceId };
    record.providers = Array.isArray(payload.providers) ? payload.providers : record.providers;
    record.activeProviderId = cleanText(payload.activeProviderId) || record.activeProviderId;
  }

  ingestRosterSnapshot(message = {}) {
    const payload = message.payload || {};
    const deviceId = cleanText(message.deviceId || payload.deviceId);
    const record = this.ensureDevice(deviceId);
    if (!record) return;
    record.roster = Array.isArray(payload.agents) ? payload.agents : [];
  }

  findPendingForEnvelope(message = {}) {
    const replyTo = cleanText(message.replyTo || message.correlationId);
    if (replyTo && this.pending.has(replyTo)) return this.pending.get(replyTo);
    return null;
  }

  handleActivity(message = {}) {
    const pending = this.findPendingForEnvelope(message);
    if (!pending) return;
    const payload = message.payload || {};
    const normalized = {
      type: mapActivityStatus(payload.status),
      data: {
        agent: pending.virtualAgentId,
        status: cleanText(payload.status),
        message: cleanText(payload.message),
        tool: cleanText(payload.tool),
        input: payload.input,
        source: 'direct-chat',
        chat: true,
        sessionId: pending.sessionId,
        relay: true,
        relayDeviceId: pending.deviceId,
        relayDeviceName: pending.deviceName || pending.deviceId,
        relayProviderId: pending.providerId,
        relayRemoteAgentId: pending.remoteAgentId,
        platform: pending.platform,
      },
    };
    try { pending.onEvent?.(normalized); } catch {}
    this.emit('event', normalized);
  }

  handleResponse(message = {}) {
    const pending = this.findPendingForEnvelope(message);
    if (!pending) return;
    const payload = message.payload || {};
    pending.resolve({
      text: cleanText(payload.text),
      runtime: cleanText(payload.runtime) || 'relay',
      model: cleanText(payload.model),
      sessionId: cleanText(payload.sessionId) || pending.sessionId,
      providerSessionId: cleanText(payload.providerSessionId),
      raw: message,
    });
  }

  handleCommandFailure(message = {}) {
    const pending = this.findPendingForEnvelope(message);
    if (!pending) return;
    const payload = message.payload || {};
    const error = new Error(cleanText(payload.message) || 'Relay request failed.');
    pending.reject(error);
  }
}

const relayAgentSource = new RelayAgentSource();

export default relayAgentSource;
export { buildRelayAppUrl, relayAgentId };
