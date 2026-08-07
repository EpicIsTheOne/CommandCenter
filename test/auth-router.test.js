import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthRouter } from '../server/routes/auth.js';

// The auth router must register the expected route handlers and expose a UI
// API policy. We don't boot Express here — just assert the router stack is
// populated and the policy function exists, so a future refactor that drops a
// route fails fast.
test('auth router registers the expected auth + setup routes', () => {
  const { router, uiApiPolicy } = createAuthRouter({ basePath: '' });
  assert.equal(typeof uiApiPolicy, 'function', 'createAuthRouter must expose a UI API policy');
  const layers = router.stack.map((layer) => layer.route?.path).filter(Boolean);
  const expected = [
    '/api/auth/status',
    '/api/auth/setup',
    '/api/auth/login',
    '/api/auth/change-password',
    '/api/auth/logout',
    '/api/setup/capabilities',
    '/api/auth/reika',
  ];
  for (const path of expected) {
    assert.ok(layers.includes(path), `auth router missing route ${path}`);
  }
});

test('auth router honors a non-empty BASE_PATH prefix', () => {
  const { router } = createAuthRouter({ basePath: '/nexus' });
  const layers = router.stack.map((layer) => layer.route?.path).filter(Boolean);
  assert.ok(layers.includes('/nexus/api/auth/status'), 'route should be mounted under BASE_PATH');
  assert.ok(!layers.includes('/api/auth/status'), 'route should NOT be mounted at the bare path');
});
