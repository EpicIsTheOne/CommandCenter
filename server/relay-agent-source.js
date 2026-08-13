import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { RELAY_OWNER_ID } from './relay-protocol.js';

const REQUEST_TIMEOUT_MS = 120000;
const MAX_PENDING_RELAY_CHATS = 8;

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
    status: cleanText(agent.status),
    capabilities: Array.isArray(agent.capabilities) ? agent.capabilities.map((value) => cleanText(value)).filter(Boolean).slice(0, 64) : [],
    steerSupported: agent.steerSupported === true,
    index,
    raw: agent,
  };
}

function buildVirtualAgent(device = {}, provider = {}, agent = {}, index = 0, transport = 'legacy', runtime = {}) {
  const remoteAgentId = cleanText(agent.id || agent.agentId || agent.name);
  if (!remoteAgentId) return null;
  const providerId = cleanText(provider.id || provider.providerId || provider.kind || provider.name) || 'provider';
  const deviceId = cleanText(device.id) || 'device';
  const label = cleanText(agent.label || agent.name || remoteAgentId) || remoteAgentId;
  const deviceLabel = pickDeviceLabel(device);
  const activity = runtime.activity || {};
  const presence = runtime.presence || {};
  const status = cleanText(activity.status || agent.status || presence.state);
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
    relayTransport: transport,
    relayAgentStatus: status,
    relayAgentMessage: cleanText(activity.message),
    relayAgentTool: cleanText(activity.tool),
    relayAgentActivityAt: activity.updatedAt || null,
    capabilities: Array.from(new Set([...(Array.isArray(agent.capabilities) ? agent.capabilities : []), 'agent.roster.read', 'agent.status.read', 'task.status.read', 'task.progress.read', 'task.review.read', 'task.start', 'task.queue', 'task.cancel', 'task.retry'])),
    steerSupported: agent.steerSupported === true,
    relayControlV2: agent.steerSupported === true || (Array.isArray(agent.capabilities) && agent.capabilities.includes('task.steer')),
    relayDeviceState: cleanText(presence.state),
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
    this.pendingControl = new Map();
    this.controlEventListeners = new Map();
    this.controlEventIds = new Set();
    this.reconnectTimer = null;
    this.lastRosterSignature = '';
    this.localManager = null;
    this.localManagerListeners = null;
    this.localEnabled = false;
    this.localConnected = false;
  }

  updateDevicePresence(deviceId = '', presence = {}) {
    const record = this.ensureDevice(deviceId);
    if (!record) return null;
    record.presence = {
      ...(record.presence || {}),
      ...presence,
      deviceId: cleanText(deviceId),
    };
    return record;
  }

  attachLocalManager(manager) {
    if (!manager || typeof manager.on !== 'function') throw new Error('A relay manager is required.');
    if (this.localManager === manager) return this;
    if (this.localManager && this.localManagerListeners) {
      for (const [event, listener] of Object.entries(this.localManagerListeners)) this.localManager.off?.(event, listener);
    }
    this.localManager = manager;
    const isOwned = (entry = {}) => entry.ownerId === RELAY_OWNER_ID && !!cleanText(entry.deviceId);
    const refreshLocalConnectionState = () => {
      const presence = typeof manager.listPresence === 'function' ? manager.listPresence() : [];
      for (const entry of presence) {
        if (isOwned(entry)) this.updateDevicePresence(entry.deviceId, entry);
      }
      this.localConnected = presence.some((entry) => isOwned(entry) && entry.state !== 'offline');
    };
    const onConnected = (entry = {}) => {
      if (!isOwned(entry)) return;
      this.localEnabled = true;
      this.localConnected = true;
      this.updateDevicePresence(entry.deviceId, { ...entry, state: 'online' });
      this.emitRosterUpdated(true);
    };
    const onDisconnected = (entry = {}) => {
      if (!isOwned(entry)) return;
      this.localEnabled = true;
      this.updateDevicePresence(entry.deviceId, { ...entry, state: 'offline' });
      refreshLocalConnectionState();
      this.rejectPendingForDevice(entry.deviceId);
      this.emitRosterUpdated(true);
    };
    const onMessage = (message = {}) => this.ingestLocalMessage(message);
    this.localManagerListeners = { connected: onConnected, disconnected: onDisconnected, message: onMessage };
    manager.on('connected', onConnected);
    manager.on('disconnected', onDisconnected);
    manager.on('message', onMessage);
    refreshLocalConnectionState();
    return this;
  }

  ingestLocalMessage(message = {}) {
    if (message?.ownerId !== RELAY_OWNER_ID || !cleanText(message?.deviceId)) return false;
    this.localEnabled = true;
    const record = this.ensureDevice(message.deviceId);
    record.transport = 'device';
    if (!record.presence || record.presence.state === 'unknown') {
      this.updateDevicePresence(message.deviceId, { ownerId: RELAY_OWNER_ID, state: 'online' });
    }
    this.handleMessage(message);
    return true;
  }

  rejectPendingForDevice(deviceId = '') {
    const id = cleanText(deviceId);
    for (const pending of this.pending.values()) {
      if (pending.deviceId === id) pending.reject(new Error('Relay device disconnected.'));
    }
    for (const pending of this.pendingControl.values()) {
      if (pending.deviceId === id) pending.reject(new Error('Relay device disconnected.'));
    }
    for (const [key, listener] of this.controlEventListeners) {
      if (listener.deviceId !== id) continue;
      clearTimeout(listener.timer);
      this.controlEventListeners.delete(key);
    }
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
    for (const pending of this.pendingControl.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Relay connection stopped.'));
    }
    this.pendingControl.clear();
    for (const listener of this.controlEventListeners.values()) clearTimeout(listener.timer);
    this.controlEventListeners.clear();
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
      enabled: this.enabled || this.localEnabled,
      url: this.url,
      connected: this.connected || this.localConnected,
      legacyEnabled: this.enabled,
      localEnabled: this.localEnabled,
      deviceCount: this.devices.size,
      agentCount: this.getAgents().length,
    };
  }

  getAgents() {
    if (!this.enabled && !this.localEnabled) return [];
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
        const virtual = buildVirtualAgent(
          record.device,
          activeProvider,
          normalized,
          index,
          record.transport || 'legacy',
          {
            presence: record.presence,
            activity: record.activities?.get(normalized.id),
          },
        );
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
      relayTransport: agent.relayTransport,
      relayVirtualAgentId: agent.id,
      chatTransport: 'relay',
    };
  }

  isRelaySession(session = {}) {
    return session?.metadata?.chatTransport === 'relay' || session?.metadata?.relay === true || !!this.getAgent(session?.agent || '');
  }

  async sendRelayControlOperation({ session = null, task = null, operation = 'status', payload = {}, onEvent } = {}) {
    const metadata = session?.metadata || {};
    const virtualAgentId = cleanText(metadata.relayVirtualAgentId || session?.agent || task?.agent);
    const virtualAgent = this.getAgent(virtualAgentId);
    const deviceId = cleanText(metadata.relayDeviceId || virtualAgent?.relayDeviceId);
    const providerId = cleanText(metadata.relayProviderId || virtualAgent?.relayProviderId) || 'hermes';
    const remoteAgentId = cleanText(metadata.relayAgentId || virtualAgent?.relayAgentId || task?.agent);
    if (!deviceId || !remoteAgentId) throw new Error('Relay control target is incomplete.');
    const transport = cleanText(virtualAgent?.relayTransport || metadata.relayTransport);
    const useLocalDeviceTransport = transport === 'device' && !!(this.localManager && typeof this.localManager.sendControlRequest === 'function');
    if (!useLocalDeviceTransport && (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN)) throw new Error('Relay device is not connected.');
    const operationId = cleanText(payload.operationId) || `control:${cleanText(task?.id || session?.id)}:${operation}:${Date.now().toString(36)}`;
    const requestId = `cc_control_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const requestPayload = {
      operation,
      operationId,
      taskId: cleanText(payload.taskId || task?.id),
      threadId: cleanText(payload.threadId || task?.threadId || metadata.threadId),
      attemptId: cleanText(payload.attemptId || task?.attemptId),
      agentId: remoteAgentId,
      providerId,
      ...(payload.title ? { title: cleanText(payload.title).slice(0, 240) } : {}),
      ...(payload.prompt ? { prompt: cleanText(payload.prompt).slice(0, 12000) } : {}),
      ...(payload.guidance ? { guidance: cleanText(payload.guidance).slice(0, 4000) } : {}),
      ...(payload.expectedTaskRevision !== undefined ? { expectedTaskRevision: Number(payload.expectedTaskRevision) } : {}),
    };
    const request = useLocalDeviceTransport
      ? { v: 2, id: requestId, type: 'relay.control.request', timestamp: new Date().toISOString(), payload: requestPayload }
      : { v: 2, id: requestId, type: 'agent.control.request', timestamp: new Date().toISOString(), source: { kind: 'app', id: 'openclaw-command-center' }, target: { kind: 'device', id: deviceId }, deviceId, payload: requestPayload };
    const eventKey = `${deviceId}:${cleanText(task?.id || payload.taskId)}:${cleanText(task?.attemptId || payload.attemptId)}`;
    const removeEventListener = () => {
      const listener = this.controlEventListeners.get(eventKey);
      if (!listener) return;
      clearTimeout(listener.timer);
      this.controlEventListeners.delete(eventKey);
    };
    if (onEvent) {
      const eventTimer = setTimeout(removeEventListener, REQUEST_TIMEOUT_MS);
      this.controlEventListeners.set(eventKey, { deviceId, taskId: cleanText(task?.id || payload.taskId), attemptId: cleanText(task?.attemptId || payload.attemptId), operationId, onEvent, timer: eventTimer });
    }
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(requestId);
        reject(new Error('Relay control request timed out.'));
      }, REQUEST_TIMEOUT_MS);
      this.pendingControl.set(requestId, {
        requestId,
        operationId,
        sessionId: cleanText(session?.id),
        taskId: cleanText(task?.id || payload.taskId),
        virtualAgentId,
        deviceId,
        providerId,
        remoteAgentId,
        deviceName: cleanText(metadata.relayDeviceName || virtualAgent?.relayDeviceName),
        platform: cleanText(metadata.relayPlatform || virtualAgent?.relayPlatform),
        onEvent,
        resolve: (value) => {
          clearTimeout(timer);
          this.pendingControl.delete(requestId);
          if (!(operation === 'cancel' && value?.state === 'cancelling' && onEvent)) removeEventListener();
          resolve(value);
        },
        reject: (error) => { clearTimeout(timer); this.pendingControl.delete(requestId); removeEventListener(); reject(error); },
        timer,
      });
      let sent = false;
      try {
        if (useLocalDeviceTransport) sent = this.localManager.sendControlRequest(deviceId, request);
        else { this.ws.send(JSON.stringify(request)); sent = true; }
      } catch {}
      if (!sent) {
        clearTimeout(timer);
        this.pendingControl.delete(requestId);
        removeEventListener();
        reject(new Error('Relay device is not connected.'));
      }
    });
  }

  async runRelayControlTask({ session, task, onEvent } = {}) {
    const result = await this.sendRelayControlOperation({
      session,
      task,
      operation: 'start',
      onEvent,
      payload: { title: task?.title, prompt: task?.prompt, taskId: task?.id, threadId: task?.threadId, attemptId: task?.attemptId, operationId: `task:${task?.id}:attempt:${task?.attemptId}:start` },
    });
    return {
      text: cleanText(result.result || result.summary),
      runtime: 'relay',
      model: cleanText(result.model),
      sessionId: cleanText(result.sessionId || session?.id),
      providerSessionId: cleanText(result.providerSessionId),
      raw: result.raw || result,
    };
  }

  async steerRelayTask({ session, task, guidance, onEvent } = {}) {
    return this.sendRelayControlOperation({ session, task, operation: 'steer', onEvent, payload: { guidance, taskId: task?.id, operationId: `task:${task?.id}:attempt:${task?.attemptId}:steer:${Date.now().toString(36)}` } });
  }

  async cancelRelayTask({ session, task, onEvent } = {}) {
    return this.sendRelayControlOperation({ session, task, operation: 'cancel', onEvent, payload: { taskId: task?.id, operationId: `task:${task?.id}:attempt:${task?.attemptId}:cancel` } });
  }

  async runRelayChatTurn({ session, latestMessage, onEvent } = {}) {
    const metadata = session?.metadata || {};
    const deviceId = cleanText(metadata.relayDeviceId);
    const providerId = cleanText(metadata.relayProviderId) || 'openclaw';
    const remoteAgentId = cleanText(metadata.relayAgentId || metadata.relayAgentLabel || session?.agent);
    const virtualAgentId = cleanText(metadata.relayVirtualAgentId || session?.agent);
    if (!deviceId) throw new Error('Relay session is missing relayDeviceId.');
    if (!remoteAgentId) throw new Error('Relay session is missing relayAgentId.');
    const currentAgentTransport = cleanText(this.getAgent(virtualAgentId)?.relayTransport);
    const relayTransport = currentAgentTransport || cleanText(metadata.relayTransport);
    const useLocalDeviceTransport = relayTransport === 'device' && !!(this.localManager && typeof this.localManager.sendChatRequest === 'function');
    if (useLocalDeviceTransport && providerId !== 'hermes') throw new Error('Only Hermes relay chat is supported.');
    if (!useLocalDeviceTransport && (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN)) throw new Error('Relay device is not connected.');
    if (this.pending.size >= MAX_PENDING_RELAY_CHATS) throw new Error('Relay chat is busy.');

    const requestId = `cc_relay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const providerSessionId = cleanText(metadata.relayProviderSessionId) || `commandcenter_api_${cleanText(session?.id) || Date.now().toString(36)}`;
    const remoteSessionId = cleanText(metadata.relayRemoteSessionId);

    const request = useLocalDeviceTransport
      ? {
        v: 1,
        id: requestId,
        type: 'relay.chat.request',
        timestamp: new Date().toISOString(),
        payload: {
          providerId,
          agentId: remoteAgentId,
          ...(remoteSessionId ? { sessionId: remoteSessionId } : {}),
          providerSessionId,
          message: cleanText(latestMessage),
        },
      }
      : {
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
          providerSessionId,
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
        providerSessionId,
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
      let sent = false;
      try {
        if (useLocalDeviceTransport) sent = this.localManager.sendChatRequest(deviceId, request);
        else { this.ws.send(JSON.stringify(request)); sent = true; }
      } catch {
        sent = false;
      }
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error('Relay device is not connected.'));
      }
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
    if (type === 'relay.capabilities.snapshot' || type === 'agent.capabilities.snapshot') {
      this.ingestCapabilitiesSnapshot(message);
      this.emitRosterUpdated();
      return;
    }
    if (type === 'relay.presence' || type === 'relay.disconnect') {
      this.updateDevicePresence(message.deviceId, {
        ...(message.payload || {}),
        state: type === 'relay.disconnect' ? 'offline' : cleanText(message.payload?.state) || 'online',
      });
      this.emitRosterUpdated(true);
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
    if (type === 'relay.chat.response') {
      this.handleResponse(message);
      return;
    }
    if (type === 'relay.control.response' || type === 'agent.control.response') {
      this.handleControlResponse(message);
      return;
    }
    if (type === 'relay.control.event' || type === 'agent.control.event' || type === 'relay.replay.response') {
      this.handleControlEvent(message);
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
        status: agent.relayAgentStatus,
        activity: agent.relayAgentMessage,
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
        transport: 'legacy',
        presence: { state: 'unknown' },
        activities: new Map(),
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
    this.updateDevicePresence(deviceId, { ownerId: message.ownerId, state: 'online' });
  }

  ingestRosterSnapshot(message = {}) {
    const payload = message.payload || {};
    const deviceId = cleanText(message.deviceId || payload.deviceId);
    const record = this.ensureDevice(deviceId);
    if (!record) return;
    record.roster = Array.isArray(payload.agents) ? payload.agents : [];
    this.updateDevicePresence(deviceId, { ownerId: message.ownerId, state: 'online' });
  }

  ingestCapabilitiesSnapshot(message = {}) {
    const payload = message.payload || {};
    const deviceId = cleanText(message.deviceId || payload.deviceId);
    const record = this.ensureDevice(deviceId);
    if (!record || !Array.isArray(payload.agents)) return;
    const capabilities = new Map(payload.agents.map((agent) => [cleanText(agent.id || agent.agentId || agent.name), agent]));
    record.roster = (record.roster || []).map((agent) => {
      const id = cleanText(agent.id || agent.agentId || agent.name);
      const extra = capabilities.get(id) || {};
      return { ...agent, capabilities: extra.capabilities || agent.capabilities || [], steerSupported: extra.steerSupported === true || agent.steerSupported === true };
    });
    for (const agent of payload.agents) {
      const id = cleanText(agent.id || agent.agentId || agent.name);
      if (id && !record.roster.some((item) => cleanText(item.id || item.agentId || item.name) === id)) record.roster.push(agent);
    }
    this.updateDevicePresence(deviceId, { ownerId: message.ownerId, state: 'online' });
  }

  findPendingForEnvelope(message = {}) {
    const replyTo = cleanText(message.replyTo || message.correlationId);
    if (replyTo && this.pending.has(replyTo)) return this.pending.get(replyTo);
    return null;
  }

  handleActivity(message = {}) {
    const pending = this.findPendingForEnvelope(message);
    const payload = message.payload || {};
    const deviceId = cleanText(message.deviceId || pending?.deviceId);
    const remoteAgentId = cleanText(payload.agent || pending?.remoteAgentId);
    const record = this.ensureDevice(deviceId);
    if (record && remoteAgentId) {
      const previous = record.activities?.get(remoteAgentId) || {};
      record.activities.set(remoteAgentId, {
        ...previous,
        status: cleanText(payload.status),
        message: cleanText(payload.message),
        tool: cleanText(payload.tool),
        input: payload.input,
        updatedAt: new Date().toISOString(),
      });
      while (record.activities.size > 128) {
        const oldest = record.activities.keys().next().value;
        if (!oldest) break;
        record.activities.delete(oldest);
      }
    }
    const virtualAgent = this.getAgents().find((agent) => (
      agent.relayDeviceId === deviceId && agent.relayAgentId === remoteAgentId
    ));
    const normalized = {
      type: mapActivityStatus(payload.status),
      data: {
        agent: virtualAgent?.id || pending?.virtualAgentId || remoteAgentId,
        status: cleanText(payload.status),
        message: cleanText(payload.message),
        tool: cleanText(payload.tool),
        input: payload.input,
        source: 'direct-chat',
        chat: true,
        sessionId: pending?.sessionId,
        relay: true,
        relayDeviceId: pending?.deviceId || deviceId,
        relayDeviceName: pending?.deviceName || record?.device?.name || deviceId,
        relayProviderId: pending?.providerId,
        relayRemoteAgentId: remoteAgentId,
        platform: pending?.platform || cleanText(record?.device?.platform || record?.device?.type),
      },
    };
    try { pending?.onEvent?.(normalized); } catch {}
    this.emit('event', normalized);
  }

  handleResponse(message = {}) {
    const pending = this.findPendingForEnvelope(message);
    if (!pending) return;
    if (message.ownerId === RELAY_OWNER_ID && message.deviceId !== pending.deviceId) return;
    const payload = message.payload || {};
    if (message.type === 'relay.chat.response') {
      if (payload.providerSessionId && payload.providerSessionId !== pending.providerSessionId) {
        pending.reject(new Error('Relay chat response session mismatch.'));
        return;
      }
      if (payload.ok === false) {
        pending.reject(new Error(cleanText(payload.errorMessage) || 'Relay chat failed.'));
        return;
      }
    }
    pending.resolve({
      text: cleanText(payload.text),
      runtime: cleanText(payload.runtime) || 'relay',
      model: cleanText(payload.model),
      sessionId: cleanText(payload.sessionId) || pending.sessionId,
      providerSessionId: cleanText(payload.providerSessionId) || pending.providerSessionId,
      raw: message,
    });
  }

  handleControlResponse(message = {}) {
    const replyTo = cleanText(message.replyTo || message.correlationId);
    const pending = replyTo ? this.pendingControl.get(replyTo) : null;
    if (!pending) return;
    if (message.ownerId === RELAY_OWNER_ID && message.deviceId !== pending.deviceId) return;
    const payload = message.payload || {};
    if (payload.operationId && payload.operationId !== pending.operationId) {
      pending.reject(new Error('Relay control operation mismatch.'));
      return;
    }
    if (payload.ok === false) {
      const error = new Error(cleanText(payload.errorMessage) || 'Relay control operation failed.');
      error.code = cleanText(payload.errorCode) || 'RELAY_CONTROL_FAILED';
      pending.reject(error);
      return;
    }
    pending.resolve({
      ...payload,
      runtime: 'relay',
      raw: message,
    });
  }

  handleControlEvent(message = {}) {
    const eventId = cleanText(message.id);
    if (eventId && this.controlEventIds.has(eventId)) return;
    if (eventId) {
      this.controlEventIds.add(eventId);
      while (this.controlEventIds.size > 2000) this.controlEventIds.delete(this.controlEventIds.values().next().value);
    }
    const replyTo = cleanText(message.replyTo || message.correlationId);
    const pending = this.pendingControl.get(replyTo);
    const payload = message.payload || {};
    const deviceId = cleanText(message.deviceId || pending?.deviceId);
    const eventListener = !pending
      ? [...this.controlEventListeners.values()].find((listener) => listener.deviceId === deviceId && listener.taskId === cleanText(payload.taskId) && (!listener.attemptId || listener.attemptId === cleanText(payload.attemptId)))
      : null;
    const context = pending || eventListener;
    const record = this.ensureDevice(deviceId);
    const remoteAgentId = cleanText(payload.agentId || pending?.remoteAgentId || eventListener?.remoteAgentId);
    const virtualAgent = this.getAgents().find((agent) => agent.relayDeviceId === deviceId && agent.relayAgentId === remoteAgentId);
    const state = cleanText(payload.state || payload.eventType);
    const status = state === 'completed' ? 'idle' : state === 'failed' || state === 'cancelled' ? 'error' : 'working';
    const normalized = {
      type: mapActivityStatus(status),
      data: {
        agent: virtualAgent?.id || pending?.virtualAgentId || eventListener?.virtualAgentId || remoteAgentId,
        status,
        message: cleanText(payload.summary || payload.result || payload.eventType),
        tool: 'control-plane',
        source: 'relay-control',
        chat: false,
        relay: true,
        relayDeviceId: context?.deviceId || deviceId,
        relayDeviceName: context?.deviceName || record?.device?.name || deviceId,
        relayProviderId: context?.providerId,
        relayRemoteAgentId: remoteAgentId,
        taskId: cleanText(payload.taskId || context?.taskId),
        state,
        revision: payload.revision,
        progressSequence: payload.progressSequence,
      },
    };
    try { context?.onEvent?.(normalized); } catch {}
    if (['completed', 'failed', 'cancelled'].includes(state) && eventListener) {
      clearTimeout(eventListener.timer);
      for (const [key, listener] of this.controlEventListeners) if (listener === eventListener) this.controlEventListeners.delete(key);
    }
    this.emit('control:event', { ...message, normalized });
    this.emit('event', normalized);
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
