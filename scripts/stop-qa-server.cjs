#!/usr/bin/env node
// Stops ONLY the QA server recorded in the PID file — after verifying its
// command line belongs to this checkout's QA setup (localhost peace treaty).
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PID_FILE = path.join(os.tmpdir(), 'cc-qa-server.pid');
const BASE_URL = `http://127.0.0.1:${Number(process.env.QA_PORT || 3100)}`;

function readPid() {
  try {
    const pid = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidCommandLine(pid) {
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
      { encoding: 'utf8', timeout: 10000 }
    ).trim();
  } catch {
    return '';
  }
}

function isOurServer(cmdline) {
  // Absolute entry path written by start-qa-server.cjs — identifies this checkout.
  const norm = String(cmdline).toLowerCase().replace(/\//g, '\\');
  return norm.includes('commandcenterr\\commandcenter\\server\\index.js') || norm.includes('cc-qa-data');
}

function main() {
  const pid = readPid();
  if (!pid) {
    console.error('[stop-qa] no PID file at ' + PID_FILE + ' — nothing tracked to stop.');
    process.exit(1);
  }
  if (!pidAlive(pid)) {
    console.log(`[stop-qa] pid ${pid} already dead; cleaning up PID file.`);
    fs.unlinkSync(PID_FILE);
    return;
  }
  const cmdline = pidCommandLine(pid);
  if (!isOurServer(cmdline)) {
    console.error(`[stop-qa] REFUSING to kill pid ${pid}: command line does not match this checkout's QA server.`);
    console.error('[stop-qa] cmdline: ' + (cmdline || '(unavailable)'));
    process.exit(2);
  }
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'pipe' });
    console.log(`[stop-qa] killed pid ${pid} (tree)`);
  } catch (err) {
    console.error('[stop-qa] taskkill failed:', err.message);
    process.exit(1);
  }
  try { fs.unlinkSync(PID_FILE); } catch {}
  // Liveness confirmation loop
  const deadline = Date.now() + 8000;
  const check = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  while (check() && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  console.log(check() ? '[stop-qa] WARNING: process still alive' : '[stop-qa] confirmed down');
}

main();
