export function classifyApiRoute(pathname, basePath = '') {
  const path = String(pathname || '');
  const publicRoutes = new Set([
    `${basePath}/api/auth/status`,
    `${basePath}/api/auth/login`,
    `${basePath}/api/auth/setup`,
  ]);
  if (!path.startsWith(`${basePath}/api/`)) return 'non-api';
  if (publicRoutes.has(path)) return 'public';
  if (path.startsWith(`${basePath}/api/v1/`)) return 'api-token';
  return 'ui-session';
}

export function createUiApiPolicy({ basePath = '', loadAuth, readSessionToken, validateSession } = {}) {
  return async (req, res, next) => {
    const policy = classifyApiRoute(req.path, basePath);
    if (policy !== 'ui-session') return next();
    const auth = await loadAuth();
    if (!auth.enabled) return res.status(403).json({ ok: false, error: 'Operator password setup is required.', code: 'SETUP_REQUIRED' });
    if (!validateSession(readSessionToken(req))) return res.status(401).json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
    next();
  };
}
