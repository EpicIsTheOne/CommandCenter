import config from './config.js';

function normalizeAddress(value = '') {
  return String(value || '').trim();
}

function isLoopbackAddress(value = '') {
  const addr = normalizeAddress(value);
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export function apiAuthEnabled() {
  return !!String(config.apiKey || '').trim();
}

export function isLocalApiRequest(req) {
  if (!config.localApiEnabled) return false;
  const remote = normalizeAddress(req.socket?.remoteAddress);
  const localPort = Number(req.socket?.localPort || 0);
  return isLoopbackAddress(remote) && localPort === Number(config.localApiPort || 0);
}

export function requireApiAuth(req, res, next) {
  if (isLocalApiRequest(req)) {
    res.setHeader('X-CommandCenter-Auth-Mode', 'local-bypass');
    return next();
  }

  const configured = String(config.apiKey || '').trim();
  if (!configured) {
    return res.status(503).json({
      ok: false,
      error: 'Public API key is not configured. Set COMMANDCENTER_API_KEY or use the localhost-only local API listener.',
      code: 'PUBLIC_API_KEY_REQUIRED',
    });
  }

  const auth = String(req.headers.authorization || '').trim();
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || token !== configured) {
    return res.status(401).json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
  }
  res.setHeader('X-CommandCenter-Auth-Mode', 'bearer');
  next();
}
