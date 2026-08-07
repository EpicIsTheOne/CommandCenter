import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

export const ATTACHMENT_LIMITS = Object.freeze({ maxCount: 10, maxTotalBytes: 20 * 1024 * 1024, maxTextBytes: 256 * 1024, maxPromptChars: 600_000, maxPdfPages: 40 });

// pdf-parse pulls in pdfjs-dist, which executes `new DOMMatrix()` at module load
// and relies on an optional native binding (@napi-rs/canvas). When that binding
// is absent (headless host, minimal container, mismatched libc), importing it at
// module scope crashes the entire server. Load it lazily and degrade gracefully
// so an optional dependency can never take down startup.
let pdfParseModule = null;
let pdfParseFailed = false;
async function safePdfParse() {
  if (pdfParseFailed) return null;
  if (pdfParseModule) return pdfParseModule;
  try {
    pdfParseModule = await import('pdf-parse');
  } catch (err) {
    pdfParseFailed = true;
    console.error('[attachment-bundle] PDF extraction unavailable (optional dependency failed to load); PDFs will be reported as degraded.');
    return null;
  }
  return pdfParseModule;
}
const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.json', '.jsonl', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.htm', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.log', '.csv', '.tsv', '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.sh', '.ps1', '.sql']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function inside(root, target) {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target === root || target.startsWith(prefix);
}

function status(file, state, detail = '') {
  return { id: String(file?.id || ''), name: String(file?.originalName || file?.name || 'file'), status: state, detail };
}

// Returns { ok: true, text } on success, or { ok: false } when the optional
// PDF dependency is unavailable. Never throws for a missing dependency.
async function extractPdf(path, limits) {
  const mod = await safePdfParse();
  if (!mod || !mod.PDFParse) return { ok: false };
  const parser = new mod.PDFParse({ data: await readFile(path) });
  try {
    const result = await parser.getText({ first: limits.maxPdfPages });
    return { ok: true, text: String(result?.text || '').slice(0, limits.maxPromptChars) };
  } finally {
    await parser.destroy();
  }
}

export async function buildAttachmentBundle(files = [], { libraryDir, requestedIds = [], limits = {} } = {}) {
  const effective = { ...ATTACHMENT_LIMITS, ...limits };
  const root = await realpath(resolve(libraryDir));
  const wanted = Array.from(new Set((requestedIds.length ? requestedIds : files.map((f) => f.id)).map(String)));
  const byId = new Map(files.map((file) => [String(file.id), file]));
  const statuses = [];
  const context = [];
  const images = [];
  let totalBytes = 0;
  let promptChars = 0;

  for (const id of wanted.slice(0, effective.maxCount)) {
    const file = byId.get(id);
    if (!file) {
      statuses.push({ id, name: '', status: 'rejected', detail: 'Attachment is missing from the managed manifest.' });
      continue;
    }
    if (file.kind === 'link') {
      context.push(`Reference link ${file.name || id}: ${String(file.sourceUrl || '')}`);
      statuses.push(status(file, 'consumed', 'Link retained as a reference; it was not fetched.'));
      continue;
    }
    try {
      const candidate = await realpath(resolve(String(file.path || '')));
      if (!inside(root, candidate)) {
        statuses.push(status(file, 'rejected', 'Stored path is outside the managed chat library.'));
        continue;
      }
      const info = await stat(candidate);
      if (!info.isFile()) throw new Error('Stored attachment is not a regular file.');
      totalBytes += info.size;
      if (totalBytes > effective.maxTotalBytes) {
        statuses.push(status(file, 'rejected', 'Aggregate attachment byte limit exceeded.'));
        continue;
      }
      const ext = extname(file.originalName || file.name || candidate).toLowerCase();
      if (TEXT_EXTS.has(ext)) {
        const bytes = await readFile(candidate);
        const truncated = bytes.length > effective.maxTextBytes;
        const text = bytes.subarray(0, effective.maxTextBytes).toString('utf8');
        const remaining = Math.max(0, effective.maxPromptChars - promptChars);
        const bounded = text.slice(0, remaining);
        promptChars += bounded.length;
        context.push(`--- BEGIN ATTACHMENT: ${file.originalName || file.name} ---\n${bounded}\n--- END ATTACHMENT: ${file.originalName || file.name} ---`);
        statuses.push(status(file, truncated || bounded.length < text.length ? 'truncated' : 'consumed', truncated ? 'Text content was bounded by the per-file limit.' : 'Text content was inlined.'));
      } else if (ext === '.pdf') {
        const extracted = await extractPdf(candidate, effective);
        if (!extracted.ok) {
          statuses.push(status(file, 'degraded', 'PDF text extraction is unavailable in this deployment; the file was attached without extracted text.'));
          continue;
        }
        const text = extracted.text;
        const remaining = Math.max(0, effective.maxPromptChars - promptChars);
        const bounded = text.slice(0, remaining);
        promptChars += bounded.length;
        context.push(`--- BEGIN PDF TEXT: ${file.originalName || file.name} ---\n${bounded}\n--- END PDF TEXT: ${file.originalName || file.name} ---`);
        statuses.push(status(file, bounded.length < text.length ? 'truncated' : 'consumed', 'PDF text extracted server-side.'));
      } else if (IMAGE_EXTS.has(ext)) {
        images.push({ id, name: file.originalName || file.name, path: candidate, mimeType: file.mimeType || '' });
        statuses.push(status(file, 'consumed', 'Image prepared for an image-capable backend.'));
      } else {
        statuses.push(status(file, 'unsupported', 'Binary attachment type is not supported.'));
      }
    } catch (err) {
      statuses.push(status(file, 'rejected', err?.code === 'ENOENT' ? 'Stored file is missing.' : String(err.message || 'Attachment could not be read.')));
    }
  }
  for (const id of wanted.slice(effective.maxCount)) {
    statuses.push({ id, name: byId.get(id)?.name || '', status: 'rejected', detail: 'Attachment count limit exceeded.' });
  }
  return { context: context.join('\n\n'), images, statuses, totalBytes };
}
