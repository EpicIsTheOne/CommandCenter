import { WebSocketServer } from 'ws';
import { RELAY_DEVICE_WS_PATH, RELAY_MAX_PAYLOAD_BYTES, parseRelayMessage, validateRelayAuth } from './relay-protocol.js';

const AUTH_TIMEOUT_MS = 5_000;

function rejectUpgrade(socket, status = 400, reason = 'Bad Request') {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {}
  try { socket.destroy(); } catch {}
}

function authOkEnvelope(enrolled) {
  return {
    v: 1,
    id: `auth_${Date.now().toString(36)}`,
    type: 'relay.auth.ok',
    timestamp: new Date().toISOString(),
    payload: {
      ownerId: enrolled.device.ownerId,
      deviceId: enrolled.device.id,
      ...(enrolled.credential ? { credential: enrolled.credential } : {}),
    },
  };
}

export function createRelayDeviceUpgrade({ basePath = '', relayManager, useHttps = false, authTimeoutMs = AUTH_TIMEOUT_MS } = {}) {
  if (!relayManager) throw new Error('relayManager is required.');
  const relayWss = new WebSocketServer({ noServer: true, maxPayload: RELAY_MAX_PAYLOAD_BYTES });

  relayWss.on('connection', (ws, req) => {
    let authenticated = false;
    let deviceId = '';
    const authTimer = setTimeout(() => { try { ws.close(4001, 'Authentication required'); } catch {} }, authTimeoutMs);
    ws.on('message', async (raw) => {
      try {
        if (!authenticated) {
          const auth = validateRelayAuth(parseRelayMessage(raw));
          const enrolled = await relayManager.authenticate(ws, auth, req.socket?.remoteAddress || 'unknown');
          if (!enrolled) { ws.close(4001, 'Authentication failed'); return; }
          authenticated = true;
          deviceId = enrolled.device.id;
          clearTimeout(authTimer);
          ws.send(JSON.stringify(authOkEnvelope(enrolled)));
          return;
        }
        relayManager.handle(ws, raw, deviceId);
      } catch (err) {
        try {
          ws.send(JSON.stringify({
            v: 1,
            id: `err_${Date.now().toString(36)}`,
            type: 'relay.auth.error',
            timestamp: new Date().toISOString(),
            payload: { code: err.code || 'INVALID_MESSAGE' },
          }));
        } catch {}
        try { ws.close(4008, 'Invalid relay message'); } catch {}
      }
    });
    ws.on('close', () => { clearTimeout(authTimer); if (authenticated) relayManager.disconnect(ws, deviceId); });
  });

  function tryUpgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url || '/', `${useHttps ? 'https' : 'http'}://localhost`); } catch { rejectUpgrade(socket); return true; }
    const expectedPath = `${basePath || ''}${RELAY_DEVICE_WS_PATH}`;
    if (url.pathname !== expectedPath) return false;
    if (url.search) { rejectUpgrade(socket, 400, 'Query Not Allowed'); return true; }
    relayWss.handleUpgrade(req, socket, head, (ws) => relayWss.emit('connection', ws, req));
    return true;
  }

  return { relayWss, tryUpgrade };
}
