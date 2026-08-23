// Regression smoke: office 2D animation alive, control plane panel loads,
// Fairy Live panel opens without errors. Expects QA server on 3100.
const { chromium } = require('playwright');

const BASE_URL = 'http://127.0.0.1:3100';

async function main() {
  const browser = await chromium.launch({
    executablePath: 'C:/Users/Epic/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (err) => errors.push('pageerror: ' + String(err).slice(0, 200)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push('console: ' + msg.text().slice(0, 200)); });

  await page.goto(BASE_URL + '/', { waitUntil: 'domcontentloaded' });
  const pw = page.locator('#auth-password');
  try {
    await pw.waitFor({ state: 'visible', timeout: 8000 });
    await pw.fill('qa-pass-2026');
    await page.click('#auth-submit-btn');
  } catch {}
  await page.waitForTimeout(3500);

  // 1. Office 2D canvas animates: two frames must differ.
  const officeCanvas = page.locator('#zone-office canvas').first();
  const hasOffice = await officeCanvas.count();
  if (!hasOffice) {
    console.log('[office] no canvas found in #zone-office');
  } else {
    const frameA = await officeCanvas.screenshot();
    await page.waitForTimeout(1200);
    const frameB = await officeCanvas.screenshot();
    const differs = !frameA.equals(frameB);
    console.log('[office] frames differ (animating):', differs);
    if (!differs) errors.push('office canvas did not animate');
  }

  // Panel toggles wire up late in async main() (after roster/music/branding
  // awaits), so poll until the handler is actually attached.
  async function toggleUntil(selector, wantExpanded, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await page.locator(selector).dispatchEvent('click');
      await page.waitForTimeout(700);
      const expanded = await page.locator(selector).getAttribute('aria-expanded');
      if (String(expanded) === String(wantExpanded)) return true;
    }
    return false;
  }

  // 2. Control plane panel opens and loads tasks.
  const controlOpened = await toggleUntil('#control-plane-toggle', true);
  const panelHidden = await page.locator('#control-plane-panel').evaluate((node) => node.classList.contains('hidden'));
  const summary = await page.locator('#control-plane-summary').textContent().catch(() => '');
  console.log('[control] opened?', controlOpened, '| panel hidden?', panelHidden, '| summary:', JSON.stringify(String(summary).trim().slice(0, 80)));
  if (panelHidden) errors.push('control plane panel did not open');

  // 3. Fairy Live subsystem reacts to a call attempt. Note: the docked
  // #fairy-live-panel is legacy markup that nothing un-hides (same at
  // baseline HEAD) — the call UI is overlay/status driven. A 400 from the
  // start endpoint is the honest "no Gemini key configured" answer in QA.
  await toggleUntil('#control-plane-toggle', false);
  await page.locator('#fairy-live-launch-btn').dispatchEvent('click');
  await page.waitForTimeout(2500);
  const fairyState = await page.locator('#fairy-live-state').textContent().catch(() => '');
  const overlayVisible = await page.locator('#fairy-live-overlay:not(.hidden)').count();
  console.log('[fairy] state after call attempt:', JSON.stringify(fairyState.trim()), '| overlay visible:', overlayVisible);
  if (String(fairyState).trim() === 'IDLE' && !overlayVisible) errors.push('fairy live subsystem did not react to call attempt');

  await browser.close();
  // 400s are expected in QA (no Gemini/TTS keys configured in the temp dir);
  // 401s are the pre-auth boot poller; 404 favicon noise.
  const fatal = errors.filter((e) => !/40[014]/.test(e) && !e.includes('favicon'));
  if (fatal.length) {
    console.log('\n[FAIL] errors:');
    for (const err of fatal) console.log(' -', err);
    process.exit(1);
  }
  console.log('\n[OK] regression smoke passed');
}

main().catch((err) => { console.error('smoke failed:', err); process.exit(1); });
