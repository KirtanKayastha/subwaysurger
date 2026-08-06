/**
 * Hoverboard inventory regression test.
 *
 * The reported bug: a hoverboard bought once came back after every death,
 * because the run-start stock was rebuilt from the profile by applyUpgrades()
 * and the in-run decrement was never persisted.
 *
 * This drives the real UI - grant coins, buy from the shop, crash, reload -
 * and asserts the stock only ever goes down. A unit test could not catch the
 * original bug, because every individual piece was already correct; only the
 * round trip through localStorage and a page reload exposes it.
 *
 *   node tools/inventory_check.mjs [baseUrl]
 */

import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:8123';
const problems = [];
const log = (...a) => console.log(' ', ...a);

/** Stock as the engine, the profile and the shop each see it. */
const readStock = (page) => page.evaluate(() => {
  const profile = JSON.parse(localStorage.getItem('neonrush.profile') || '{}');
  const inventory = JSON.parse(localStorage.getItem('neonrush.inventory') || '{}');
  return {
    engine: window.__game ? window.__game.hoverboardsLeft : null,
    player: window.__game ? window.__game.player.hoverboards : null,
    inventory: inventory.hoverboard ?? null,
    profile: (profile.upgrades || {}).hoverboard ?? null,
  };
});

const waitForMenu = (page) =>
  page.waitForFunction(() => !!document.querySelector('#ui-root .btn--primary'), { timeout: 15000 });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();

page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await waitForMenu(page);

// --- grant coins so the shop is usable --------------------------------------
// The server is authoritative when it is up, so writing coins into
// localStorage alone would be overwritten by the next /api/me. Bank coins
// through the real API instead, staying inside the anti-cheat envelope:
// the claimed duration may not exceed the token's real age + 15s, and coins
// are capped at 1.6/metre + 600 flat.
const granted = await page.evaluate(async () => {
  const token = JSON.parse(localStorage.getItem('neonrush.token') || 'null');
  if (!token) return 'offline';
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const reasons = [];
  for (let i = 0; i < 3; i++) {
    const start = await fetch('/api/run/start', { method: 'POST', headers }).then((r) => r.json());
    if (!start.ok) return 'start failed';
    await new Promise((r) => setTimeout(r, 1200));
    const res = await fetch('/api/run/submit', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        runToken: start.runToken,
        // ~1.2s elapsed: stay well under elapsed + 15s.
        durationMs: 9000,
        // 9s at <=80m/s*1.25 leaves plenty of headroom at 600m.
        distance: 600,
        // Under 600*1.6 + 600.
        coins: 500,
        score: 3000,
        bestCombo: 5,
      }),
    }).then((r) => r.json());
    if (!res.accepted) reasons.push((res.reasons || []).join(','));
  }
  const me = await fetch('/api/me', { headers }).then((r) => r.json());
  return reasons.length
    ? `rejected: ${reasons.join(' | ')}`
    : (me.player ? me.player.coins : 'no profile');
});
log('coins granted:', granted);

await page.evaluate(() => localStorage.removeItem('neonrush.inventory'));
await page.reload({ waitUntil: 'networkidle' });
await waitForMenu(page);

const startingCoins = await page.evaluate(() =>
  (JSON.parse(localStorage.getItem('neonrush.profile') || '{}')).coins);
log('coins available:', startingCoins);
if (!(startingCoins >= 300)) problems.push(`not enough coins to test: ${startingCoins}`);

// --- buy two hoverboards ---------------------------------------------------
await page.click('text=SHOP');
await page.waitForTimeout(400);

const boardRow = page.locator('.shop-item', { hasText: 'Hoverboard' });
if (!(await boardRow.count())) problems.push('hoverboard row missing from shop');

const stockLabel = async () => (await boardRow.first().textContent()) || '';
if (!(await stockLabel()).includes('x0')) {
  problems.push(`shop should show x0 when out, got: ${(await stockLabel()).trim()}`);
}
log('shop shows x0 when empty');

for (let i = 0; i < 2; i++) {
  await boardRow.first().locator('text=BUY').click();
  await page.waitForTimeout(350);
}
if (!(await stockLabel()).includes('x2')) {
  problems.push(`expected x2 after two buys, got: ${(await stockLabel()).trim()}`);
}
log('bought 2 hoverboards, shop shows x2');

await page.click('text=BACK');
await page.waitForTimeout(400);

// --- run 1: crash twice, spending both boards ------------------------------
await page.click('.btn--primary');
await page.waitForTimeout(4200);

const atStart = await readStock(page);
log('run 1 start:', JSON.stringify(atStart));
if (atStart.engine !== 2) problems.push(`run 1 should start with 2 boards, got ${atStart.engine}`);

// Each _impact on a real hazard spends one board and revives.
await page.evaluate(() => window.__game._impact({ kind: 'barrier' }));
await page.waitForTimeout(500);
const afterOne = await readStock(page);
log('after 1st save:', JSON.stringify(afterOne));
if (afterOne.engine !== 1) problems.push(`expected 1 board left, got ${afterOne.engine}`);
if (afterOne.inventory !== 1) problems.push(`inventory not persisted: ${afterOne.inventory}`);
if (afterOne.profile !== 1) problems.push(`profile not updated: ${afterOne.profile}`);

await page.evaluate(() => window.__game._impact({ kind: 'barrier' }));
await page.waitForTimeout(500);
const afterTwo = await readStock(page);
log('after 2nd save:', JSON.stringify(afterTwo));
if (afterTwo.engine !== 0) problems.push(`expected 0 boards left, got ${afterTwo.engine}`);

// Third hit has no board to spend, so it must actually kill.
await page.evaluate(() => window.__game._impact({ kind: 'barrier' }));
await page.waitForTimeout(2600);
if (!(await page.locator('text=RUN AGAIN').count())) {
  problems.push('third hit with 0 boards did not end the run');
}
log('empty stock is fatal');

// --- run 2: the bug. Stock must NOT come back ------------------------------
await page.click('text=RUN AGAIN');
await page.waitForTimeout(4200);
const run2 = await readStock(page);
log('run 2 start:', JSON.stringify(run2));
if (run2.engine !== 0) {
  problems.push(`REGRESSION: boards respawned after death (${run2.engine})`);
}

// --- reload: stock must survive a restart ----------------------------------
await page.reload({ waitUntil: 'networkidle' });
await waitForMenu(page);
const afterReload = await readStock(page);
log('after reload:', JSON.stringify(afterReload));
if (afterReload.inventory !== 0) {
  problems.push(`inventory did not survive reload: ${afterReload.inventory}`);
}
if (afterReload.profile !== 0) {
  problems.push(`profile did not survive reload: ${afterReload.profile}`);
}

await page.click('text=SHOP');
await page.waitForTimeout(400);
const finalLabel = (await page.locator('.shop-item', { hasText: 'Hoverboard' }).first().textContent()) || '';
if (!finalLabel.includes('x0')) {
  problems.push(`shop should show x0 after spending, got: ${finalLabel.trim()}`);
}
log('shop shows x0 after spending');

await browser.close();

console.log('');
if (problems.length) {
  console.error(`FAIL: ${problems.length} problem(s)`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('PASS: hoverboards are consumed, persisted, and never respawn.');
