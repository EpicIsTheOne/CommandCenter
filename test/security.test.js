import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyApiRoute, createUiApiPolicy } from '../server/route-policy.js';
import { isLoopbackAddress, createRateLimiter, securityHeaders } from '../server/request-security.js';
import config from '../server/config.js';
import { isLocalApiRequest } from '../server/api-auth.js';
import { enforceUploadBudget } from '../server/upload-policy.js';

test('route authorization matrix protects sensitive browser APIs', () => {
  assert.equal(classifyApiRoute('/api/auth/status'), 'public');
  assert.equal(classifyApiRoute('/api/auth/login'), 'public');
  assert.equal(classifyApiRoute('/api/v1/chat'), 'api-token');
  for (const path of ['/api/fairy/memory', '/api/call/start', '/api/live/tasks', '/api/settings/voice', '/api/chat/direct']) {
    assert.equal(classifyApiRoute(path), 'ui-session', path);
  }
});

test('UI policy rejects missing setup and invalid sessions', async () => {
  const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  let res = response();
  await createUiApiPolicy({ loadAuth: async () => ({ enabled: false }), readSessionToken: () => '', validateSession: () => false })({ path: '/api/fairy/memory' }, res, () => assert.fail('must reject'));
  assert.equal(res.statusCode, 403);
  res = response();
  await createUiApiPolicy({ loadAuth: async () => ({ enabled: true }), readSessionToken: () => 'bad', validateSession: () => false })({ path: '/api/call/start' }, res, () => assert.fail('must reject'));
  assert.equal(res.statusCode, 401);
});

test('loopback detection ignores spoofable headers', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('10.0.0.8'), false);
});

test('local API bypass requires both loopback peer and configured local listener port', () => {
  const prior = { enabled: config.localApiEnabled, port: config.localApiPort };
  config.localApiEnabled = true;
  config.localApiPort = 3001;
  try {
    assert.equal(isLocalApiRequest({ socket: { remoteAddress: '127.0.0.1', localPort: 3001 }, headers: {} }), true);
    assert.equal(isLocalApiRequest({ socket: { remoteAddress: '127.0.0.1', localPort: 3000 }, headers: {} }), false);
    assert.equal(isLocalApiRequest({ socket: { remoteAddress: '198.51.100.2', localPort: 3001 }, headers: { host: '127.0.0.1', 'x-forwarded-for': '127.0.0.1' } }), false);
  } finally {
    config.localApiEnabled = prior.enabled;
    config.localApiPort = prior.port;
  }
});

test('authentication attempt limiter throttles repeated attempts', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
  const req = { socket: { remoteAddress: '192.0.2.1' } };
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; }, json() { return this; } };
  let passes = 0;
  limiter(req, res, () => { passes += 1; });
  limiter(req, res, () => { passes += 1; });
  limiter(req, res, () => { passes += 1; });
  assert.equal(passes, 2);
  assert.equal(res.statusCode, 429);
});

test('upload aggregate limit rejects many individually valid files', () => {
  const middleware = enforceUploadBudget({ maxFiles: 3, maxBytes: 20 });
  const req = { files: [{ size: 8 }, { size: 8 }, { size: 8 }] };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  middleware(req, res, () => assert.fail('must reject aggregate overflow'));
  assert.equal(res.statusCode, 413);
  assert.equal(res.body.code, 'UPLOAD_LIMIT');
});

test('security headers include nosniff, referrer, frame, and CSP controls', () => {
  const headers = {};
  securityHeaders({}, { setHeader(name, value) { headers[name] = value; } }, () => {});
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.equal(headers['X-Frame-Options'], 'SAMEORIGIN');
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'self'/);
});
