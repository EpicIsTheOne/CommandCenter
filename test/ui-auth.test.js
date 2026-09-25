import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

test('UI sessions are bounded to relay-only unconfigured mode and generated token format', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-ui-auth-'));
  const script = [
    "import config from './server/config.js';",
    "import { createSession, isValidSession, setUiPassword } from './server/ui-auth.js';",
    "config.relayOnlyMode = false;",
    "if (await isValidSession('a'.repeat(64))) throw new Error('malformed session accepted');",
    "let blocked = false; try { await createSession({ allowUnconfigured: true }); } catch { blocked = true; }",
    "if (!blocked) throw new Error('unconfigured session was created outside relay-only mode');",
    "await setUiPassword('audit-password-2026');",
    "const session = await createSession();",
    "if (!/^[a-f0-9]{64}$/.test(session.token)) throw new Error('invalid generated token');",
    "if (!(await isValidSession(session.token))) throw new Error('generated session rejected');",
    "if (await isValidSession('not-a-token')) throw new Error('malformed session accepted');",
  ].join(';');
  try {
    await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, COMMANDCENTER_DATA_DIR: directory },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
