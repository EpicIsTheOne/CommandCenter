import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);
test('Windows-compatible demo startup survives missing optional Python', { timeout: 25000 }, async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  await execFileAsync(process.execPath, [join(here, '..', 'scripts', 'startup-smoke.cjs')], { cwd: join(here, '..'), timeout: 22000 });
});
