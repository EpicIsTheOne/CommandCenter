#!/usr/bin/env node
const { chromium } = require('playwright');

const BASE = process.env.CC_BASE_URL || 'http://127.0.0.1:3001/commandcenter';
const PASSWORD = process.env.CC_AUTH_PASSWORD || '';
const MODE = process.argv.includes('--autosave') ? 'autosave' : 'manual';
const NOTE = `playwright ${MODE} verification ${Date.now()}`;
let moduleUrl = `${BASE}/js/fairy-live.js`;

function summarizeResponses(responses) {
  const counts = {};
  for (const line of responses) {
    const status = line.split(' ', 1)[0] || 'unknown';
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

async function authenticateIfNeeded(page) {
  const authVisible = await page.locator('#auth-modal').evaluate((el) => !el.classList.contains('hidden')).catch(() => false);
  if (!authVisible) return;
  if (!PASSWORD) throw new Error('Command Center auth is visible; set CC_AUTH_PASSWORD to run this verifier.');
  await page.fill('#auth-password', PASSWORD);
  await page.click('#auth-submit-btn');
  await page.waitForFunction(() => document.querySelector('#auth-modal')?.classList.contains('hidden'), null, { timeout: 10000 });
  await page.waitForTimeout(1500);
}


async function waitForSessionId(page) {
  try {
    await page.waitForFunction(() => /call-[a-f0-9-]{36}/.test(document.querySelector('#fairy-live-transcript')?.textContent || ''), null, { timeout: 30000 });
  } catch (err) {
    const debug = await page.evaluate(() => ({
      launchText: document.querySelector('#fairy-live-launch-btn')?.textContent || '',
      launchClass: document.querySelector('#fairy-live-launch-btn')?.className || '',
      state: document.querySelector('#fairy-live-state')?.textContent || '',
      status: document.querySelector('#fairy-live-status')?.textContent || '',
      transcript: document.querySelector('#fairy-live-transcript')?.textContent || '',
      authHidden: document.querySelector('#auth-modal')?.classList.contains('hidden'),
    })).catch(() => ({}));
    throw new Error(`${err.message} :: ${JSON.stringify(debug)}`);
  }
  return await page.evaluate(() => (document.querySelector('#fairy-live-transcript')?.textContent || '').match(/call-[a-f0-9-]{36}/)?.[0] || '');
}

async function clickWhenUsable(page, selector, timeout = 30000) {
  await page.waitForFunction((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return !el.disabled && !el.classList.contains('hidden') && rect.width > 0 && rect.height > 0;
  }, selector, { timeout });
  await page.locator(selector).click({ timeout: 10000 });
}

async function resolveFairyModuleUrl(page) {
  const res = await page.request.get(`${BASE}/js/app.js?verify=${Date.now()}`);
  const source = await res.text();
  const match = source.match(/['"]\.\/fairy-live\.js\?v=([^'"]+)/);
  if (!match) throw new Error('Could not resolve fairy-live import version from app.js');
  return `${BASE}/js/fairy-live.js?v=${match[1]}`;
}

async function dispatchFairyEvent(page, sessionId, event) {
  await page.evaluate(async ({ moduleUrl, sessionId, event }) => {
    const fairy = await import(moduleUrl);
    fairy.handleEvent({ type: event.type, data: { sessionId, ...event.data } });
  }, { moduleUrl, sessionId, event });
}

(async () => {
  const launchOptions = {
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--enable-usermedia-screen-capturing',
      '--allow-http-screen-capture',
      '--auto-select-desktop-capture-source=Entire screen',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  };
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_PATH || '';
  if (executablePath) launchOptions.executablePath = executablePath;
  const browser = await chromium.launch(launchOptions);

  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, permissions: ['microphone', 'camera'] });
  const page = await context.newPage();
  const logs = [];
  const responses = [];
  page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('response', (res) => {
    const url = res.url();
    if (url.includes('/api/call/') || url.includes('/api/fairy/recordings')) responses.push(`${res.status()} ${url}`);
  });

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    moduleUrl = await resolveFairyModuleUrl(page);
    await authenticateIfNeeded(page);

    await page.waitForSelector('#fairy-live-launch-btn', { state: 'visible', timeout: 15000 });
    const initialLaunchText = await page.locator('#fairy-live-launch-btn').textContent().catch(() => '');
    if (/end call/i.test(initialLaunchText || '')) {
      await page.locator('#fairy-live-launch-btn').click({ timeout: 10000 });
      await page.waitForTimeout(2500);
    }

    await page.waitForTimeout(500);
    await page.evaluate(() => document.querySelector('#fairy-live-launch-btn')?.click());
    const sessionId = await waitForSessionId(page);

    await clickWhenUsable(page, '#fairy-live-screen-header-btn');
    await page.waitForFunction(() => (document.querySelector('#fairy-live-screen-status')?.textContent || '').toLowerCase().includes('streaming'), null, { timeout: 30000 });

    await dispatchFairyEvent(page, sessionId, { type: 'call:recording.command', data: { action: 'start', notes: NOTE } });
    await page.waitForTimeout(3500);

    if (MODE === 'autosave') {
      await dispatchFairyEvent(page, sessionId, { type: 'call:end.requested', data: { reason: 'playwright-autosave' } });
      await page.waitForTimeout(7000);
    } else {
      await dispatchFairyEvent(page, sessionId, { type: 'call:recording.command', data: { action: 'stop', reason: 'playwright-manual-stop' } });
      await page.waitForTimeout(4500);
      await dispatchFairyEvent(page, sessionId, { type: 'call:end.requested', data: { reason: 'playwright-cleanup' } }).catch(() => {});
      await page.waitForTimeout(2500);
    }

    const state = await page.evaluate(() => ({
      state: document.querySelector('#fairy-live-state')?.textContent || '',
      status: document.querySelector('#fairy-live-status')?.textContent || '',
      overlay: document.querySelector('#fairy-live-overlay')?.textContent || '',
      transcript: document.querySelector('#fairy-live-transcript')?.textContent || '',
    }));

    const recsResponse = await page.request.get(`${BASE}/api/fairy/recordings`);
    const recs = await recsResponse.json();
    const record = recs.recordings?.find((r) => r.notes === NOTE) || null;
    if (!record) throw new Error(`Recording not found for note: ${NOTE}`);
    if (!Number(record.bytes || 0)) throw new Error(`Recording has no bytes: ${record.id}`);
    if (!String(record.mimeType || '').includes('video/')) throw new Error(`Recording mimeType is not video: ${record.mimeType}`);

    const download = await page.request.get(`${BASE}${record.downloadUrl.replace(/^\/commandcenter/, '')}`);
    if (!download.ok()) throw new Error(`Recording download failed: ${download.status()}`);
    const downloadBytes = (await download.body()).length;
    if (downloadBytes !== Number(record.bytes || 0)) throw new Error(`Downloaded bytes mismatch: ${downloadBytes} !== ${record.bytes}`);

    const result = {
      ok: true,
      mode: MODE,
      sessionId,
      record: {
        id: record.id,
        filename: record.filename,
        mimeType: record.mimeType,
        bytes: record.bytes,
        durationMs: record.durationMs,
        includeMic: record.includeMic,
        includeFairy: record.includeFairy,
        downloadUrl: record.downloadUrl,
      },
      state,
      responseCounts: summarizeResponses(responses),
      late404s: responses.filter((line) => line.startsWith('404 ')),
      relevantLogs: logs.filter((line) => /FairyLive|Failed to load resource|recording|ended/i.test(line)).slice(-40),
    };
    console.log(JSON.stringify(result, null, 2));
    if (result.late404s.length) process.exitCode = 2;
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error('VERIFY_FAILED');
  console.error(err.stack || err);
  process.exit(1);
});
