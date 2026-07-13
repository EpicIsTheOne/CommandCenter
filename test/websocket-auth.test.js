import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import config from '../server/config.js';
import { authorizeWebSocketRequest } from '../server/request-security.js';

async function fixture() {
  config.apiKey = 'test-bearer-secret';
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const auth = authorizeWebSocketRequest(req, { validateSession: (token) => token === 'valid-cookie' });
    if (!auth.ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => { ws.send('accepted'); wss.emit('connection', ws, req); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, wss, url: `ws://127.0.0.1:${server.address().port}/ws` };
}

function connect(url, options = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, options);
    ws.once('message', (data) => { ws.close(); resolve({ accepted: String(data) === 'accepted', status: 101 }); });
    ws.once('unexpected-response', (_req, res) => { res.resume(); resolve({ accepted: false, status: res.statusCode }); });
    ws.once('error', () => {});
  });
}

test('websocket upgrade rejects anonymous and invalid cookies, accepts valid UI session and bearer', async (t) => {
  const { server, wss, url } = await fixture();
  t.after(() => { wss.close(); server.close(); });
  assert.deepEqual(await connect(url), { accepted: false, status: 401 });
  assert.deepEqual(await connect(url, { headers: { Cookie: 'cc_auth=invalid', Origin: `http://127.0.0.1:${server.address().port}` } }), { accepted: false, status: 401 });
  assert.deepEqual(await connect(url, { headers: { Cookie: 'cc_auth=valid-cookie', Origin: `http://127.0.0.1:${server.address().port}` } }), { accepted: true, status: 101 });
  assert.deepEqual(await connect(url, { headers: { Authorization: 'Bearer test-bearer-secret' } }), { accepted: true, status: 101 });
});

test('spoofed forwarding headers do not create a websocket bypass', async (t) => {
  const { server, wss, url } = await fixture();
  t.after(() => { wss.close(); server.close(); });
  assert.deepEqual(await connect(url, { headers: { Host: '127.0.0.1', 'X-Forwarded-For': '127.0.0.1', Forwarded: 'for=127.0.0.1' } }), { accepted: false, status: 401 });
});
