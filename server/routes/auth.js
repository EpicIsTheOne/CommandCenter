// Auth + operator-setup routes, extracted from server/index.js into a focused
// router. The handlers reuse the same auth primitives as before (ui-auth,
// request-security, platform-capabilities) so behavior is identical; this only
// moves wiring out of the monolith.
import { Router } from 'express';
import {
  loadUiAuthConfig,
  setUiPassword,
  checkPassword,
  createSessionToken,
  createSession,
  isValidSession,
  revokeSession,
} from '../ui-auth.js';
import {
  createRateLimiter,
  isVerifiedLoopback,
  validReikaEmbedToken,
} from '../request-security.js';
import { getPlatformCapabilities } from '../platform-capabilities.js';
import { parseCookies, setAuthCookie, clearAuthCookie } from '../cookie-helpers.js';
import { createUiApiPolicy } from '../route-policy.js';

export function createAuthRouter({ basePath = '' } = {}) {
  const router = Router();
  const p = (path) => `${basePath}${path}`;

  router.get(p('/api/auth/status'), async (req, res) => {
    const auth = await loadUiAuthConfig();
    const token = parseCookies(req).cc_auth;
    const authenticated = auth.enabled ? isValidSession(token) : true;
    res.json({ ok: true, passwordSet: auth.enabled, authenticated });
  });

  const authAttemptLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 8 });

  router.post(p('/api/auth/setup'), authAttemptLimiter, async (req, res) => {
    if (!isVerifiedLoopback(req)) return res.status(403).json({ ok: false, error: 'Initial setup is available only from this machine.', code: 'LOOPBACK_SETUP_REQUIRED' });
    const auth = await loadUiAuthConfig();
    if (auth.enabled) return res.status(400).json({ ok: false, error: 'Password already set' });
    const password = String(req.body?.password || '');
    if (password.length < 12) return res.status(400).json({ ok: false, error: 'Password must be at least 12 characters' });
    await setUiPassword(password);
    const token = createSessionToken();
    createSession(token);
    setAuthCookie(res, token);
    res.json({ ok: true });
  });

  router.post(p('/api/auth/login'), authAttemptLimiter, async (req, res) => {
    const auth = await loadUiAuthConfig();
    if (!auth.enabled) return res.json({ ok: true, passwordSet: false });
    const password = String(req.body?.password || '');
    if (!checkPassword(password, auth.passwordHash)) return res.status(401).json({ ok: false, error: 'Authentication failed' });
    const token = createSessionToken();
    createSession(token);
    setAuthCookie(res, token);
    res.json({ ok: true, passwordSet: true });
  });

  router.post(p('/api/auth/change-password'), async (req, res) => {
    const auth = await loadUiAuthConfig();
    const token = parseCookies(req).cc_auth;
    if (auth.enabled && !isValidSession(token)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (auth.enabled && !checkPassword(currentPassword, auth.passwordHash)) return res.status(401).json({ ok: false, error: 'Authentication failed' });
    if (newPassword.length < 12) return res.status(400).json({ ok: false, error: 'New password must be at least 12 characters' });
    await setUiPassword(newPassword);
    const nextToken = createSessionToken();
    createSession(nextToken);
    setAuthCookie(res, nextToken);
    res.json({ ok: true });
  });

  router.post(p('/api/auth/logout'), async (req, res) => {
    const token = parseCookies(req).cc_auth;
    revokeSession(token);
    clearAuthCookie(res);
    res.json({ ok: true });
  });

  router.get(p('/api/setup/capabilities'), async (_req, res) => {
    res.json({ ok: true, capabilities: await getPlatformCapabilities() });
  });

  router.post(p('/api/auth/reika'), authAttemptLimiter, async (req, res) => {
    if (!validReikaEmbedToken(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const token = createSessionToken();
    createSession(token);
    setAuthCookie(res, token);
    res.json({ ok: true });
  });

  return { router, uiApiPolicy: createUiApiPolicy({ basePath, loadAuth: loadUiAuthConfig, readSessionToken: (req) => parseCookies(req).cc_auth, validateSession: isValidSession }) };
}
