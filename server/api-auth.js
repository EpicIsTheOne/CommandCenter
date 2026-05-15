import config from './config.js';

export function apiAuthEnabled() {
  return !!String(config.apiKey || '').trim();
}

export function requireApiAuth(req, res, next) {
  const configured = String(config.apiKey || '').trim();
  if (!configured) return next();
  const auth = String(req.headers.authorization || '').trim();
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || token !== configured) {
    return res.status(401).json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
  }
  next();
}
