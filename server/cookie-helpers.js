// Cookie helpers for the UI session, extracted from server/index.js.
// `secure` follows the same rule as the monolith: prod NODE_ENV or an HTTPS
// listener (cert + key present next to server/).
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const certPath = join(here, 'cert.pem');
const keyPath = join(here, 'key.pem');
const useHttps = existsSync(certPath) && existsSync(keyPath);

export function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const out = {};
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join('=') || '');
  }
  return out;
}

export function setAuthCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' || useHttps;
  const attrs = [`cc_auth=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=604800'];
  if (secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

export function clearAuthCookie(res) {
  const secure = process.env.NODE_ENV === 'production' || useHttps;
  const attrs = ['cc_auth=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}
