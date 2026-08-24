// Mission board visual check: restyle + close affordances.
const { chromium } = require('playwright');
const OUT = 'C:/Users/Epic/AppData/Local/Temp/cc-qa-shots';
const BASE_URL = 'http://127.0.0.1:3100';

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Users/Epic/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe',
    headless: true,
  });
  const results = [];
  const shot = async (page, name) => {
    const file = `${OUT}/${name}.png`;
    await page.screenshot({ path: file });
    results.push(`${name}: ${file}`);
  };

  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', (err) => console.log('[pageerror]', String(err).slice(0, 200)));
  await page.goto(BASE_URL + '/', { waitUntil: 'domcontentloaded' });
  const pw = page.locator('#auth-password');
  try { await pw.waitFor({ state: 'visible', timeout: 8000 }); await pw.fill('qa-pass-2026'); await page.click('#auth-submit-btn'); } catch {}
  // disable intro for clean shots
  await page.evaluate(async () => { await fetch('/api/settings/intro', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) }).catch(() => {}); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Open mission board (dispatch: panel may cover the toggle)
  await page.locator('#control-plane-toggle').dispatchEvent('click');
  await page.waitForFunction(() => !document.querySelector('#control-plane-panel')?.classList.contains('hidden'), { timeout: 30000 });
  await page.waitForTimeout(1500);
  await shot(page, 'mb-01-open-1920');

  // Close via the X button
  await page.click('#control-plane-close');
  await page.waitForTimeout(400);
  const hiddenAfterX = await page.locator('#control-plane-panel').evaluate((n) => n.classList.contains('hidden'));
  console.log('[close via X] hidden?', hiddenAfterX);
  if (!hiddenAfterX) process.exit(1);

  // Reopen, close via Escape
  await page.locator('#control-plane-toggle').dispatchEvent('click');
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const hiddenAfterEsc = await page.locator('#control-plane-panel').evaluate((n) => n.classList.contains('hidden'));
  console.log('[close via Esc] hidden?', hiddenAfterEsc);
  if (!hiddenAfterEsc) process.exit(1);

  // Reopen for a settled shot + narrow layout
  await page.locator('#control-plane-toggle').dispatchEvent('click');
  await page.waitForTimeout(1200);
  await shot(page, 'mb-02-open-settled');
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(600);
  await shot(page, 'mb-03-open-900');

  await browser.close();
  console.log('=== shots ===');
  for (const line of results) console.log(line);
})().catch((e) => { console.error('failed:', e); process.exit(1); });
