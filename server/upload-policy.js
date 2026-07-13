export function uploadedFiles(req) {
  if (req.files) return Array.isArray(req.files) ? req.files : Object.values(req.files).flat();
  return req.file ? [req.file] : [];
}

export function enforceUploadBudget({ maxFiles = 10, maxBytes = 25 * 1024 * 1024 } = {}) {
  return (req, res, next) => {
    const files = uploadedFiles(req);
    const total = files.reduce((sum, file) => sum + Number(file?.size || 0), 0);
    if (files.length > maxFiles || total > maxBytes) {
      return res.status(413).json({ ok: false, error: 'Upload count or aggregate byte limit exceeded.', code: 'UPLOAD_LIMIT' });
    }
    next();
  };
}
