/**
 * Username-first flow test.
 *
 * Covers the identity change: a new browser must be asked for a name before it
 * can play, that name must be unique, it must show during the run, and a
 * returning browser must skip the prompt entirely.
 *
 *   node tools/name_check.mjs [baseUrl]
 */

import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:8123';
const problems = [];
const log = (...a) => console.log(' ', ...a);

const watch = (page, tag) => {
  page.on('pageerror', (e) => problems.push(`[${tag}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`[${tag}] console: ${m.text()}`);
  });
};

const unique = `T${Date.now().toString().slice(-7)}`;
const browser = await chromium.launch();

// =========================================================================
// New browser: must be gated on a name
// =========================================================================
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const pageA = await ctxA.newPage();
watch(pageA, 'A');

await pageA.goto(BASE, { waitUntil: 'networkidle' });
await pageA.waitForSelector('.overlay', { timeout: 15000 });

// The PLAY button must NOT be reachable before a name exists.
const gateShown = await pageA.locator('text=CHOOSE YOUR NAME').count();
if (!gateShown) problems.push('new browser was not asked for a name');
log('name gate shown on first launch');

const playBeforeName = await pageA.locator('button:has-text("PLAY")').count();
if (playBeforeName) problems.push('PLAY reachable before a name was chosen');

// START must be disabled until the name is long enough.
const startBtn = pageA.locator('button:has-text("START")');
if (!(await startBtn.isDisabled())) problems.push('START enabled with an empty name');
await pageA.fill('input', 'X');
if (!(await startBtn.isDisabled())) problems.push('START enabled with a 1-char name');
log('START gated on a valid name');

// A token must not exist yet: no silent registration.
const earlyToken = await pageA.evaluate(() => localStorage.getItem('neonrush.token'));
if (earlyToken) problems.push('a player was registered before the name was chosen');
log('no silent registration');

await pageA.fill('input', unique);
await startBtn.click();
await pageA.waitForSelector('button:has-text("PLAY")', { timeout: 15000 });
log(`claimed name: ${unique}`);

const stored = await pageA.evaluate(() => ({
  token: !!localStorage.getItem('neonrush.token'),
  profile: JSON.parse(localStorage.getItem('neonrush.profile') || '{}'),
}));
if (!stored.token) problems.push('no token stored after claiming a name');
if (stored.profile.name !== unique) {
  problems.push(`stored name is ${stored.profile.name}, expected ${unique}`);
}
if (stored.profile.claimed !== true) problems.push('profile not marked as claimed');
log('token and name persisted');

// --- name shows during the run ---
await pageA.click('button:has-text("PLAY")');
await pageA.waitForTimeout(4200);
const who = await pageA.locator('.hud__who').textContent();
if (!who || !who.includes(unique)) {
  problems.push(`HUD does not show the name, got: ${who}`);
}
log(`HUD shows: ${who.trim()}`);

// =========================================================================
// Returning browser: must skip the gate
// =========================================================================
await pageA.reload({ waitUntil: 'networkidle' });
await pageA.waitForSelector('.overlay', { timeout: 15000 });
const gateAgain = await pageA.locator('text=CHOOSE YOUR NAME').count();
if (gateAgain) problems.push('returning browser was asked for a name again');
const menuAgain = await pageA.locator('button:has-text("PLAY")').count();
if (!menuAgain) problems.push('returning browser did not reach the menu');
log('returning browser skips the gate');

// =========================================================================
// Second browser: the same name must be refused
// =========================================================================
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const pageB = await ctxB.newPage();
watch(pageB, 'B');

await pageB.goto(BASE, { waitUntil: 'networkidle' });
await pageB.waitForSelector('text=CHOOSE YOUR NAME', { timeout: 15000 });

// Case-insensitive clash.
await pageB.fill('input', unique.toLowerCase());
await pageB.locator('button:has-text("START")').click();
await pageB.waitForTimeout(1200);

const refused = await pageB.locator('text=THAT NAME IS TAKEN').count();
if (!refused) problems.push('duplicate name was not refused');
const leakedIn = await pageB.locator('button:has-text("PLAY")').count();
if (leakedIn) problems.push('duplicate name still got into the game');
log('duplicate name refused (case-insensitive)');

// Recovering with a different name must work.
await pageB.fill('input', `${unique}B`);
await pageB.locator('button:has-text("START")').click();
await pageB.waitForSelector('button:has-text("PLAY")', { timeout: 15000 });
log('second browser recovered with a free name');

await browser.close();

console.log('');
if (problems.length) {
  console.error(`FAIL: ${problems.length} problem(s)`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('PASS: username-first flow works and names are unique.');
