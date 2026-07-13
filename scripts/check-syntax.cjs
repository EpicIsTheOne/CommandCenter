#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const ignored = new Set(['node_modules', '.git', 'data', '.cache']);
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(?:js|cjs|mjs)$/.test(entry.name)) execFileSync(process.execPath, ['--check', path], { stdio: 'inherit' });
  }
}
walk(root);
console.log('Syntax check passed.');
