// Headless visual QA for CommandCenter ops surfaces.
// Boots nothing: expects the QA server already on 127.0.0.1:3100
// (scripts/start-qa-server.cjs).
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const OUT = 'C:/Users/Epic/AppData/Local/Temp/cc-qa-shots';
fs.mkdirSync(OUT, { recursive: true });
const BASE_URL = 'http://127.0.0.1:3100';

async function login(page) {
  await page.goto(BASE_URL + '/', { waitUntil: 'domcontentloaded' });
  // The app blocks in ensureUiAuth() until its own modal is submitted —
  // drive THAT flow so main() resumes and ops.init() actually runs.
  const passwordInput = page.locator('#auth-password');
  try {
    await passwordInput.waitFor({ state: 'visible', timeout: 8000 });
    await passwordInput.fill('qa-pass-2026');
    await page.click('#auth-submit-btn');
  } catch {
    console.log('[login] no auth modal appeared (maybe already authed)');
  }
  await page.waitForTimeout(3000);
  // Disable the startup intro for this throwaway QA profile so headless
  // autoplay policy can't splash the intro video over screenshots, then
  // reload for a clean boot.
  await page.evaluate(async () => {
    await fetch('/api/settings/intro', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    }).catch(() => {});
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
}

// Project a 3D point to viewport CSS pixels using the exposed QA hook.
async function projectPoint(page, x, y, z) {
  return page.evaluate(([px, py, pz]) => {
    const scene = window.__cc3dScene;
    if (!scene) return null;
    const proto = Object.getPrototypeOf(scene.camera.position);
    const point = new proto.constructor(px, py, pz);
    point.project(scene.camera);
    const rect = scene.renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + ((point.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - point.y) / 2) * rect.height,
      width: rect.width,
      height: rect.height,
    };
  }, [x, y, z]);
}

async function inspectorTitle(page) {
  return page.evaluate(() => {
    const el = document.querySelector('#ops-inspector-body h4');
    return el ? el.textContent.trim() : '';
  });
}

async function main() {
  const browser = await chromium.launch({
    executablePath: 'C:/Users/Epic/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe',
    headless: true,
  });
  const results = [];
  const shot = async (page, name) => {
    const file = path.join(OUT, name + '.png');
    await page.screenshot({ path: file, fullPage: false });
    results.push(`${name}: ${file}`);
  };

  // Large desktop
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('console', (msg) => { if (['error', 'warning'].includes(msg.type())) console.log('[console.' + msg.type() + ']', msg.text().slice(0, 300)); });
  page.on('pageerror', (err) => console.log('[pageerror]', String(err).slice(0, 300)));
  page.on('response', (res) => { if (res.status() >= 400) console.log('[http]', res.status(), res.url().slice(0, 160)); });
  await login(page);
  await shot(page, '01-startup-large');

  // Open OPS panel, then wait for live data rows inside it
  const opsToggle = page.locator('#ops-panel-toggle');
  if (await opsToggle.count()) {
    await opsToggle.click();
    await page.waitForSelector('.ops-space-row', { timeout: 15000 }).catch(() => console.log('[warn] no space rows within 15s'));
    await page.waitForTimeout(1000);
    await shot(page, '02-ops-panel');
    const countLine = await page.locator('#ops-count-line').textContent().catch(() => '');
    console.log('[ops-count-line]', JSON.stringify(countLine));
  } else {
    console.log('[fail] #ops-panel-toggle missing');
  }

  // Agents tab
  await page.click('#ops-tab-btn-agents').catch(() => {});
  await page.waitForTimeout(400);
  await shot(page, '03-agents-tab');
  const agentCount = await page.locator('.ops-agent-row').count();
  console.log('[agent rows]', agentCount);

  // Select first agent -> inspector
  const firstAgent = page.locator('.ops-agent-row').first();
  let selectedLabel = '';
  if (await firstAgent.count()) {
    await firstAgent.click();
    await page.waitForTimeout(500);
    selectedLabel = await inspectorTitle(page);
    const inspectorText = await page.locator('#ops-inspector-body').textContent().catch(() => '');
    console.log('[inspector]', inspectorText.replace(/\s+/g, ' ').slice(0, 160));
    await shot(page, '04-agent-inspector');
  }

  // Tasks + machines + harnesses tabs
  await page.click('#ops-tab-btn-tasks').catch(() => {});
  await page.waitForTimeout(400);
  await shot(page, '05-tasks-tab');
  await page.click('#ops-tab-btn-machines').catch(() => {});
  await page.waitForTimeout(600);
  await shot(page, '06-machines-tab');
  await page.click('#ops-tab-btn-harnesses').catch(() => {});
  await page.waitForTimeout(2500);
  await shot(page, '07-harnesses-tab');

  // Command palette
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(400);
  await shot(page, '08-palette-open');
  await page.fill('#palette-input', '3d');
  await page.waitForTimeout(600);
  await shot(page, '09-palette-search-3d');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(4500);
  await shot(page, '10-mode-3d');
  const zoneHidden = await page.locator('#zone-space3d').evaluate((node) => node.classList.contains('hidden')).catch(() => null);
  console.log('[zone-space3d hidden?]', zoneHidden);
  const hasCanvas = await page.locator('#cc3d-viewport canvas.cc3d-canvas').count();
  console.log('[cc3d canvas]', hasCanvas);
  const fallbackVisible = await page.locator('#cc3d-fallback:not(.hidden)').count();
  console.log('[cc3d fallback visible?]', fallbackVisible);

  // Canvas fills its viewport? (sizing fix check)
  if (hasCanvas) {
    const sizes = await page.evaluate(() => {
      const vp = document.querySelector('#cc3d-viewport');
      const cv = vp && vp.querySelector('canvas');
      if (!vp || !cv) return null;
      const vr = vp.getBoundingClientRect();
      const cr = cv.getBoundingClientRect();
      return { vp: { w: vr.width, h: vr.height }, canvas: { w: cr.width, h: cr.height } };
    });
    console.log('[canvas vs viewport]', JSON.stringify(sizes));
  }

  // Decisive 3D click-to-inspect: project each agent LABEL into screen space
  // via the QA hook and click the first one that lands INSIDE the visible
  // canvas rect (some ring positions sit behind the OPS panel overlay).
  if (hasCanvas) {
    const currentTitle = await inspectorTitle(page);
    const target = await page.evaluate((current) => {
      const scene = window.__cc3dScene;
      if (!scene) return null;
      const rect = scene.renderer.domElement.getBoundingClientRect();
      const panel = document.querySelector('#ops-spaces-panel');
      const pr = panel && !panel.classList.contains('hidden') ? panel.getBoundingClientRect() : null;
      const proto = Object.getPrototypeOf(scene.camera.position);
      const sprites = scene.agentsGroup.children.filter((c) => c.isSprite && c.userData?.ccRef);
      const visible = [];
      for (const label of sprites) {
        const point = new proto.constructor(label.position.x, label.position.y, label.position.z);
        point.project(scene.camera);
        const x = rect.left + ((point.x + 1) / 2) * rect.width;
        const y = rect.top + ((1 - point.y) / 2) * rect.height;
        const inside = x > rect.left + 40 && x < rect.right - 40 && y > rect.top + 40 && y < rect.bottom - 40;
        const behindPanel = pr && x > pr.left - 20 && y > pr.top && y < pr.bottom;
        if (inside && !behindPanel) visible.push({ x, y, ref: label.userData.ccRef });
      }
      return visible.find((v) => v.ref.label !== current) || visible[0] || null;
    }, currentTitle);
    console.log('[3d click target]', JSON.stringify(target));
    if (target) {
      const before = await inspectorTitle(page);
      await page.mouse.click(target.x, target.y);
      await page.waitForTimeout(900);
      const after = await inspectorTitle(page);
      console.log('[3d click->inspector]', JSON.stringify({ before, after, expected: target.ref.label }));
      await shot(page, '11-3d-clicked-agent');
    }
  }

  // 3D -> 2D -> 3D round trip preserving selection. Mode buttons can sit
  // under the OPS panel overlay, so dispatch clicks instead of hit-testing.
  await page.locator('#zone-space3d [data-ops-mode="2d"]').first().dispatchEvent('click');
  await page.waitForTimeout(800);
  const officeHidden = await page.locator('#zone-office').evaluate((node) => node.classList.contains('hidden'));
  const titleAfterBack = await inspectorTitle(page);
  console.log('[back in 2D — office hidden?]', officeHidden, '| inspector kept:', JSON.stringify(titleAfterBack));
  await shot(page, '12-back-to-2d');
  await page.locator('#zone-office [data-ops-mode="3d"]').first().dispatchEvent('click');
  await page.waitForTimeout(2500);
  const titleAgain3d = await inspectorTitle(page);
  const zone3dVisible = await page.locator('#zone-space3d').evaluate((node) => !node.classList.contains('hidden'));
  console.log('[forward to 3D — zone visible?', zone3dVisible, '| inspector kept:', JSON.stringify(titleAgain3d), ']');
  await shot(page, '13-roundtrip-3d');
  // and back to 2D for the narrow checks
  await page.locator('#zone-space3d [data-ops-mode="2d"]').first().dispatchEvent('click');
  await page.waitForTimeout(800);

  // Layout widths
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(700);
  await shot(page, '14-narrow-900');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(500);
  await shot(page, '15-medium-1280');

  await browser.close();
  console.log('\n=== screenshots ===');
  for (const line of results) console.log(line);
}

main().catch((error) => { console.error('QA failed:', error); process.exit(1); });
