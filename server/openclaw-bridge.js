import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import config from './config.js';
import { loadAgentRoster } from './agents.js';

function buildDemoEvents() {
  const { agents, primaryAgentId } = loadAgentRoster();
  const boss = primaryAgentId || agents[0]?.id || 'main';
  const events = [];
  for (const agent of agents) {
    events.push({ type: 'agent:idle', data: { agent: agent.id, status: agent.id === boss ? 'Standing by' : 'Ready' } });
    events.push({ type: 'agent:idle', data: { agent: agent.id, status: agent.id === boss ? 'All systems nominal' : 'Awaiting tasks' } });
  }
  return events.length ? events : [{ type: 'agent:idle', data: { agent: 'main', status: 'Standing by' } }];
}

const DEMO_EVENTS = buildDemoEvents();

let rpcId = 0;

export default class OpenClawBridge extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.demoIndex = 0;
    this.demoTimer = null;
    this.recoveryTimer = null;
    this.connected = false;
    this.connectAttempts = 0;
    this.maxConnectAttempts = 3;
    this.mode = config.relayOnlyMode ? 'relay-only' : (config.demoMode ? 'demo' : 'connecting');
    this.lastError = '';
    this.lastAuthError = '';
    this.lastFallbackReason = '';
  }

  start() {
    if (config.relayOnlyMode) {
      console.log('[bridge] Starting in RELAY-ONLY mode');
      this.startRelayOnly();
      return;
    }
    if (config.demoMode) {
      console.log('[bridge] Starting in DEMO mode');
      this.startDemo();
      return;
    }
    this.connectGateway();
  }

  stop() {
    if (this.demoTimer) clearTimeout(this.demoTimer);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    if (this.ws) this.ws.close();
  }

  // --- Bridge Modes ---

  startRelayOnly() {
    this.connected = false;
    this.mode = 'relay-only';
    this.lastError = '';
    this.lastAuthError = '';
    this.lastFallbackReason = '';
    this.emit('connected', { mode: 'relay-only', relayOnly: true });
  }

  startDemo() {
    this.connected = true;
    this.mode = 'demo';
    this.emit('connected', { mode: 'demo', fallbackReason: this.lastFallbackReason || '', authError: this.lastAuthError || '' });
    this.scheduleDemoEvent();
    this.scheduleRecoveryReconnect();
  }

  scheduleDemoEvent() {
    if (this.mode !== 'demo') return;
    const delay = 1500 + Math.random() * 3000;
    this.demoTimer = setTimeout(() => {
      if (this.mode !== 'demo') return;
      const event = DEMO_EVENTS[this.demoIndex % DEMO_EVENTS.length];
      this.demoIndex++;
      this.emit('event', event);
      this.scheduleDemoEvent();
    }, delay);
  }

  scheduleRecoveryReconnect() {
    if (config.demoMode || config.relayOnlyMode) return;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = setTimeout(() => {
      if (this.mode !== 'demo' || !this.lastFallbackReason) return;
      console.log('[bridge] Attempting recovery from demo fallback...');
      this.connected = false;
      this.mode = 'connecting';
      this.connectAttempts = 0;
      if (this.demoTimer) {
        clearTimeout(this.demoTimer);
        this.demoTimer = null;
      }
      if (this.ws) {
        this.ws.removeAllListeners();
        this.ws.close();
        this.ws = null;
      }
      this.connectGateway();
    }, 5000);
  }

  // --- Gateway Connection (RPC v3) ---

  connectGateway() {
    this.connectAttempts++;
    this.mode = 'connecting';
    console.log(`[bridge] Connecting to gateway at ${config.gatewayUrl} (attempt ${this.connectAttempts}/${this.maxConnectAttempts})`);

    if (this.connectAttempts > this.maxConnectAttempts) {
      this.fallbackToDemo();
      return;
    }

    try {
      this.ws = new WebSocket(config.gatewayUrl);
    } catch (err) {
      this.lastError = err.message || 'Failed to create gateway WebSocket';
      console.error('[bridge] Failed to create WebSocket:', err.message);
      this.fallbackToDemo('gateway-websocket-create-failed');
      return;
    }

    let authenticated = false;

    this.ws.on('open', () => {
      console.log('[bridge] Gateway WebSocket open');
      this.reconnectDelay = 1000;
      this.lastError = '';
    });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleGatewayMessage(msg, () => { authenticated = true; });
      } catch (err) {
        console.error('[bridge] Failed to parse message:', err.message);
      }
    });

    this.ws.on('close', () => {
      console.log('[bridge] Gateway connection closed');
      const wasConnected = this.connected;
      this.connected = false;
      this.mode = 'disconnected';
      this.emit('disconnected');

      if (!authenticated && !wasConnected) {
        if (this.connectAttempts >= this.maxConnectAttempts) {
          this.fallbackToDemo(this.lastAuthError ? 'gateway-auth-failed' : 'gateway-connect-failed');
          return;
        }
      }
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this.lastError = err.message || 'Gateway socket error';
      console.error('[bridge] Gateway error:', err.message);
    });
  }

  sendRpc(method, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    rpcId++;
    this.ws.send(JSON.stringify({
      type: 'req',
      id: String(rpcId),
      method,
      params,
    }));
  }

  handleGatewayMessage(msg, onAuth) {
    // RPC v3: connect.challenge event
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      console.log('[bridge] Received connect challenge, authenticating...');
      this.sendRpc('connect', {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: 'gateway-client',
          displayName: 'OpenClaw Command Center',
          mode: 'backend',
          version: '1.0.0',
          platform: 'linux',
        },
        auth: {
          token: config.gatewayToken,
        },
      });
      return;
    }

    // RPC v3: connect response (hello-ok)
    if (msg.type === 'res' && msg.ok && msg.payload?.type === 'hello-ok') {
      console.log('[bridge] Gateway authenticated! Protocol v' + msg.payload.protocol);
      this.connected = true;
      this.mode = 'live';
      this.connectAttempts = 0;
      this.lastAuthError = '';
      this.lastFallbackReason = '';
      if (this.demoTimer) {
        clearTimeout(this.demoTimer);
        this.demoTimer = null;
      }
      if (this.recoveryTimer) {
        clearTimeout(this.recoveryTimer);
        this.recoveryTimer = null;
      }
      onAuth();
      this.emit('connected', { mode: 'live' });
      return;
    }

    // RPC v3: connect error
    if (msg.type === 'res' && !msg.ok) {
      const errorMessage = msg.error?.message || JSON.stringify(msg.error);
      this.lastError = errorMessage;
      if (/token|auth|unauthor/i.test(errorMessage)) {
        this.lastAuthError = errorMessage;
      }
      console.error('[bridge] Gateway RPC error:', errorMessage);
      return;
    }

    // RPC v3: gateway events (agent activity, health, etc.)
    if (msg.type === 'event') {
      const normalized = this.normalizeEvent(msg);
      if (normalized) {
        this.emit('event', normalized);
      }
    }
  }

  normalizeEvent(msg) {
    const event = msg.event;
    const payload = msg.payload || {};

    // Map gateway event names to our internal format
    const eventMap = {
      'agent': null, // generic agent event — inspect payload
    };

    // Agent events come as event:"agent" with payload containing state info
    if (event === 'agent') {
      const agentId = payload.agentId || payload.agent || 'main';
      const state = payload.state || payload.event;
      const stateMap = {
        'idle': 'agent:idle',
        'listening': 'agent:listening',
        'thinking': 'agent:thinking',
        'tool_use': 'agent:tool_use',
        'tool_call': 'agent:tool_use',
        'responding': 'agent:responding',
        'response': 'agent:responding',
        'error': 'agent:error',
      };
      const type = stateMap[state];
      if (type) {
        return {
          type,
          data: {
            agent: agentId,
            ...payload,
          },
        };
      }
    }

    // Also handle dot-notation events from older format
    const dotMap = {
      'agent.listening': 'agent:listening',
      'agent.thinking': 'agent:thinking',
      'agent.tool_use': 'agent:tool_use',
      'agent.tool_call': 'agent:tool_use',
      'agent.responding': 'agent:responding',
      'agent.response': 'agent:responding',
      'agent.idle': 'agent:idle',
      'agent.error': 'agent:error',
    };

    const mappedType = dotMap[event];
    if (mappedType) {
      return {
        type: mappedType,
        data: {
          agent: payload.agent || payload.agent_id || 'main',
          ...payload,
        },
      };
    }

    return null;
  }

  scheduleReconnect() {
    console.log(`[bridge] Reconnecting in ${this.reconnectDelay}ms...`);
    setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      this.connectGateway();
    }, this.reconnectDelay);
  }

  fallbackToDemo(reason = '') {
    if (this.connected) return;
    this.lastFallbackReason = String(reason || 'gateway-unavailable');
    this.mode = 'demo';
    console.log(`[bridge] Gateway unavailable, falling back to demo mode (${this.lastFallbackReason})`);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.startDemo();
  }

  getStatus() {
    const configuredDemo = !!config.demoMode;
    const relayOnlyMode = !!config.relayOnlyMode;
    const requestedMode = relayOnlyMode ? 'relay-only' : (configuredDemo ? 'demo' : 'live');
    const actualMode = this.mode || (relayOnlyMode ? 'relay-only' : (configuredDemo ? 'demo' : 'disconnected'));
    return {
      connected: this.connected,
      mode: actualMode,
      requestedMode,
      gatewayUrl: config.gatewayUrl,
      gatewayTokenConfigured: !!config.gatewayToken,
      gatewayTokenSource: config.gatewayTokenSource || (config.gatewayToken ? 'env' : 'missing'),
      lastError: this.lastError,
      lastAuthError: this.lastAuthError,
      lastFallbackReason: this.lastFallbackReason,
      configuredDemo,
      relayOnlyMode,
    };
  }
}
