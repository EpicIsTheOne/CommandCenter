import { timingSafeEqual } from 'node:crypto';
import config from './config.js';

export function isLoopbackAddress(value = '') {
  const address = String(value || '').trim().toLowerCase();
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function isVerifiedLoopback(req) {
  return isLoopbackAddress(req.socket?.remoteAddress);
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (!key) continue;
    try { out[key] = decodeURIComponent(rest.join('=') || ''); } catch { out[key] = ''; }
  }
  return out;
}

export function bearerToken(req) {
  const auth = String(req.headers.authorization || '').trim();
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

export function validBearer(req) {
  const expected = Buffer.from(String(config.apiKey || '').trim());
  const supplied = Buffer.from(bearerToken(req));
  return expected.length > 0 && expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function allowedBrowserOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const host = String(req.headers.host || '').split(':')[0].toLowerCase();
    const allowed = String(process.env.COMMANDCENTER_ALLOWED_ORIGINS || '').split(',').map((v) => v.trim()).filter(Boolean);
    return url.hostname.toLowerCase() === host || allowed.includes(url.origin);
  } catch {
    return false;
  }
}

export function authorizeWebSocketRequest(req, { validateSession = () => false } = {}) {
  if (validBearer(req)) return { ok: true, mode: 'bearer' };
  const token = parseCookies(req).cc_auth;
  if (!token || !validateSession(token)) return { ok: false, status: 401, reason: 'unauthorized' };
  if (!allowedBrowserOrigin(req)) return { ok: false, status: 401, reason: 'origin' };
  return { ok: true, mode: 'ui-session' };
}

export function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; worker-src 'self' blob:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'");
  next();
}

export function createRateLimiter({ windowMs = 15 * 60_000, max = 8 } = {}) {
  const attempts = new Map();
  return (req, res, next) => {
    const key = String(req.socket?.remoteAddress || 'unknown');
    const now = Date.now();
    const recent = (attempts.get(key) || []).filter((ts) => now - ts < windowMs);
    if (recent.length >= max) {
      res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ ok: false, error: 'Too many authentication attempts. Try again later.', code: 'RATE_LIMITED' });
    }
    recent.push(now);
    attempts.set(key, recent);
    next();
  };
}
