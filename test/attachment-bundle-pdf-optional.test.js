import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildAttachmentBundle } from '../server/attachment-bundle.js';

test('attachment bundle module imports without a fatal PDF native dependency', () => {
  // If pdf-parse/pdfjs-dist crash at import time (e.g. missing optional native
  // binding in a headless or minimal-container host), this import itself throws
  // and takes the whole server down. The module must load regardless.
  assert.equal(typeof buildAttachmentBundle, 'function');
});

test('PDF attachments degrade gracefully when optional PDF extraction is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-attach-pdf-'));
  const filesDir = join(root, 'files');
  await mkdir(filesDir);
  const pdfPath = join(filesDir, 'doc.pdf');
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
  await writeFile(pdfPath, pdf);
  const records = [{ id: 'doc', path: pdfPath, name: 'doc.pdf', originalName: 'doc.pdf' }];
  const bundle = await buildAttachmentBundle(records, { libraryDir: root, requestedIds: ['doc'] });
  const st = bundle.statuses.find((s) => s.id === 'doc');
  assert.ok(st, 'PDF attachment produced a status');
  assert.ok(['consumed', 'truncated', 'degraded'].includes(st.status), `unexpected status ${st.status}`);
  // Crucially: the process did not crash and a clean bundle was returned.
  assert.equal(typeof bundle.context, 'string');
});
