/**
 * Password gate flow.
 *
 *   node tools/auth_check.mjs [baseUrl]
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

const NAME = `AU${Date.now().toString().slice(-7)}`;
const PASS = 'hunter22';

const inputs = (page) => ({
  user: page.locator('input[autocomplete="username"]'),
  pass: page.locator('input[type="password"]'),
  submit: page.locator('button[type="submit"]'),
});

const browser = await chromium.launch();

// =========================================================================
// First visit: claim with a password
// =========================================================================
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const pageA = await ctxA.newPage();
watch(pageA, 'A');

await pageA.goto(BASE, { waitUntil: 'networkidle' });
await pageA.waitForSelector('text=CHOOSE YOUR NAME', { timeout: 15000 });

const a = inputs(pageA);
if (!(await a.pass.count())) problems.push('no password field on the gate');
const label = await a.pass.getAttribute('placeholder');
if (!/OPTIONAL/i.test(label || '')) {
  problems.push(`password should be optional for a new name, got: ${label}`);
}
log(`new name -> password field reads "${label}"`);

await a.user.fill(NAME);
await a.pass.fill(PASS);
await a.submit.click();
await pageA.waitForSelector('button:has-text("PLAY")', { timeout: 15000 });
log(`claimed ${NAME} with a password`);

// Name still shows in the HUD.
await pageA.click('button:has-text("PLAY")');
await pageA.waitForTimeout(4200);
const who = await pageA.locator('.hud__who').textContent();
if (!who || !who.includes(NAME)) problems.push(`HUD badge missing name, got: ${who}`);
log(`HUD shows: ${who.trim()}`);

// =========================================================================
// Second browser: the name is now protected
// =========================================================================
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const pageB = await ctxB.newPage();
watch(pageB, 'B');

await pageB.goto(BASE, { waitUntil: 'networkidle' });
await pageB.waitForSelector('text=CHOOSE YOUR NAME', { timeout: 15000 });

const b = inputs(pageB);
await b.user.fill(NAME);
await b.user.blur();
await pageB.waitForTimeout(900);

// The probe should have switched the form into sign-in mode.
const prompt = await pageB.locator('.gate__prompt').textContent();
if (!/WELCOME BACK/i.test(prompt || '')) {
  problems.push(`expected sign-in mode after probe, prompt was: ${prompt}`);
}
const labelB = await b.pass.getAttribute('placeholder');
if (/OPTIONAL/i.test(labelB || '')) {
  problems.push('password still shown as optional for a protected name');
}
log(`existing name -> "${prompt.trim()}", password required`);

// Submit must be blocked without a password.
if (!(await b.submit.isDisabled())) {
  problems.push('sign-in allowed with an empty password');
}
log('submit blocked without a password');

// Wrong password is rejected.
await b.pass.fill('totallywrong');
await b.submit.click();
await pageB.waitForTimeout(1500);
const errText = await pageB.locator('.badge--warn').first().textContent();
if (!/INVALID PASSWORD/i.test(errText || '')) {
  problems.push(`expected "Invalid password", got: ${errText}`);
}
if (await pageB.locator('button:has-text("PLAY")').count()) {
  problems.push('wrong password still got into the game');
}
log(`wrong password -> "${errText.trim()}"`);

// Correct password signs in.
await b.pass.fill(PASS);
await b.submit.click();
await pageB.waitForSelector('button:has-text("PLAY")', { timeout: 15000 });
log('correct password signed in');

const profileB = await pageB.evaluate(() =>
  JSON.parse(localStorage.getItem('neonrush.profile') || '{}'));
if (profileB.name !== NAME) {
  problems.push(`signed in as ${profileB.name}, expected ${NAME}`);
}
const leaked = await pageB.evaluate(() =>
  JSON.stringify(localStorage).toLowerCase().includes('hunter22'));
if (leaked) problems.push('the plaintext password was stored in localStorage');
log('signed in as the right player, password not stored client-side');

await browser.close();

console.log('');
if (problems.length) {
  console.error(`FAIL: ${problems.length} problem(s)`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('PASS: password gate claims, rejects and signs in correctly.');
