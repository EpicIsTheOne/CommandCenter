import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Fairy control-plane UI exposes mission board, deterministic actions, and no stray draggable copy', async () => {
  const [html, app, module] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/js/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/js/control-plane.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="control-plane-panel"/);
  assert.match(html, /id="control-plane-toggle"/);
  assert.match(module, /\/api\/control/);
  for (const action of ['queue', 'steer', 'cancel', 'retry']) assert.match(module, new RegExp(`data-control-action=\\"${action}\\"`));
  assert.match(module, /controlEventSequence/);
  assert.match(app, /afterEventSequence/);
  assert.doesNotMatch(`${html}\n${app}\n${module}`, /To pick up a draggable item|pick up a draggable item/i);
});
