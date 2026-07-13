import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildAttachmentBundle } from '../server/attachment-bundle.js';
import { buildHermesArgs, buildOpenClawArgs } from '../server/api-chat-runner.js';

function makePdf(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('attachment bundle handles text, source, PDF, PNG, JPEG, unsupported, missing, and traversal honestly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-attachments-'));
  const filesDir = join(root, 'files');
  await mkdir(filesDir);
  const paths = {
    txt: join(filesDir, 'a.txt'), js: join(filesDir, 'a.js'), pdf: join(filesDir, 'a.pdf'),
    png: join(filesDir, 'a.png'), jpg: join(filesDir, 'a.jpg'), bin: join(filesDir, 'a.bin'),
  };
  await writeFile(paths.txt, 'TXT PROBE');
  await writeFile(paths.js, 'export const sourceProbe = true;');
  await writeFile(paths.pdf, makePdf('PDF PROBE 5821'));
  await writeFile(paths.png, Buffer.from('89504e470d0a1a0a', 'hex'));
  await writeFile(paths.jpg, Buffer.from('ffd8ffe000104a464946', 'hex'));
  await writeFile(paths.bin, Buffer.from([0, 1, 2, 3]));
  const outside = join(root, '..', `outside-${Date.now()}.txt`);
  await writeFile(outside, 'secret');
  const records = Object.entries(paths).map(([id, path]) => ({ id, path, name: `${id}.${id === 'js' ? 'js' : id}`, originalName: path.split(/[\\/]/).pop() }));
  records.push({ id: 'traversal', path: outside, name: 'outside.txt', originalName: 'outside.txt' });
  const ids = [...records.map((item) => item.id), 'missing'];
  const bundle = await buildAttachmentBundle(records, { libraryDir: root, requestedIds: ids });
  assert.match(bundle.context, /TXT PROBE/);
  assert.match(bundle.context, /sourceProbe/);
  assert.match(bundle.context, /PDF PROBE 5821/);
  assert.deepEqual(bundle.images.map((item) => item.id), ['png', 'jpg']);
  assert.equal(bundle.statuses.find((item) => item.id === 'bin').status, 'unsupported');
  assert.equal(bundle.statuses.find((item) => item.id === 'missing').status, 'rejected');
  assert.equal(bundle.statuses.find((item) => item.id === 'traversal').status, 'rejected');
});

test('attachment count, aggregate bytes, and truncation are bounded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-attachment-limits-'));
  const path = join(root, 'large.txt');
  await writeFile(path, 'x'.repeat(200));
  const bundle = await buildAttachmentBundle([{ id: 'large', path, name: 'large.txt' }], { libraryDir: root, requestedIds: ['large'], limits: { maxTextBytes: 20, maxTotalBytes: 1000 } });
  assert.equal(bundle.statuses[0].status, 'truncated');
  assert.equal(bundle.context.includes('x'.repeat(21)), false);
  const rejected = await buildAttachmentBundle([{ id: 'large', path, name: 'large.txt' }], { libraryDir: root, requestedIds: ['large'], limits: { maxTotalBytes: 10 } });
  assert.equal(rejected.statuses[0].status, 'rejected');
});

test('backend argument construction uses Hermes image input and no fake OpenClaw image flag', () => {
  const session = { id: 'abc', agent: 'main', metadata: {} };
  assert.deepEqual(buildHermesArgs('hello', session, [{ path: 'C:\\safe\\image.png' }]).slice(-2), ['--image', 'C:\\safe\\image.png']);
  assert.equal(buildOpenClawArgs('hello', session, 'main', 'low').includes('--image'), false);
});
