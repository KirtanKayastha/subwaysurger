/**
 * Browser smoke test.
 *
 * Loads the served game in headless Chromium, plays it with real keyboard and
 * touch input, and fails on any console error, page error or failed request.
 * This is the check that a module graph, canvas render loop and React mount
 * actually work together - things no static analysis can prove.
 *
 *   node tools/smoke.mjs [baseUrl]
 */

import { chromium, devices } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:8123';
const problems = [];
const log = (...a) => console.log(' ', ...a);

/** Attach error collectors to a page. */
function watch(page, tag) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`[${tag}] console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`[${tag}] pageerror: ${err.message}`));
  page.on('requestfailed', (req) => {
    problems.push(`[${tag}] request failed: ${req.url()} ${req.failure()?.errorText}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400) problems.push(`[${tag}] HTTP ${res.status()} ${res.url()}`);
  });
}

/** Read the engine's live state out of the page. */
const readState = (page) => page.evaluate(() => {
  const g = window.__game;
  if (!g) return null;
  return {
    state: g.state,
    score: Math.floor(g.score),
    distance: Math.floor(g.distance),
    coins: g.coins,
    speed: +g.speed.toFixed(1),
    hazards: g.world.hazards.length,
    particles: g.particles.count,
    playerY: +g.player.y.toFixed(2),
    lane: g.player.lane,
  };
});

const browser = await chromium.launch();

// =========================================================================
// Desktop: keyboard play
// =========================================================================
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  watch(page, 'desktop');

  await page.goto(BASE, { waitUntil: 'networkidle' });

  // Expose the engine for assertions.
  await page.waitForFunction(() => !!document.querySelector('#ui-root .btn--primary'), { timeout: 15000 });
  log('menu rendered');

  const title = await page.textContent('.title');
  if (!title?.includes('NEON RUSH')) problems.push('title missing');

  // Canvas must have a real backing store.
  const canvas = await page.evaluate(() => {
    const c = document.getElementById('game');
    return { w: c.width, h: c.height };
  });
  if (canvas.w < 100 || canvas.h < 100) problems.push(`canvas not sized: ${JSON.stringify(canvas)}`);
  log(`canvas ${canvas.w}x${canvas.h}`);

  await page.click('.btn--primary');           // PLAY
  await page.waitForTimeout(600);

  // The app exposes the engine on window.__game for exactly this purpose.
  const hooked = await page.evaluate(() => !!window.__game);
  if (!hooked) problems.push('could not reach Game instance');
  log(`engine hooked: ${hooked}`);

  // Wait past the 3-2-1 countdown.
  await page.waitForTimeout(3600);
  const running = await readState(page);
  log('after countdown:', JSON.stringify(running));
  if (running && running.state !== 'playing') problems.push(`expected playing, got ${running.state}`);

  // Play: lane changes, jumps, slides.
  for (const key of ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'ArrowLeft']) {
    await page.keyboard.press(key);
    await page.waitForTimeout(320);
  }
  await page.waitForTimeout(1500);

  const played = await readState(page);
  log('after input:', JSON.stringify(played));
  if (played) {
    if (played.distance <= 0) problems.push('runner did not move');
    if (played.score <= 0) problems.push('score did not accumulate');
    if (played.hazards <= 0) problems.push('no hazards generated');
    if (played.speed <= 0) problems.push('speed is zero');
  }

  // Pause / resume.
  await page.keyboard.press('KeyP');
  await page.waitForTimeout(400);
  if (!(await page.locator('text=PAUSED').count())) problems.push('pause overlay missing');
  log('pause works');
  await page.click('text=RESUME');
  await page.waitForTimeout(500);

  // Frame rate sanity over ~1.5 s.
  const fps = await page.evaluate(() => new Promise((resolve) => {
    let frames = 0;
    const t0 = performance.now();
    const tick = () => {
      frames++;
      if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
      else resolve(Math.round((frames * 1000) / (performance.now() - t0)));
    };
    requestAnimationFrame(tick);
  }));
  log(`fps ~${fps}`);
  if (fps < 30) problems.push(`low frame rate: ${fps}`);

  // Force a crash and confirm the results screen + persistence.
  await page.evaluate(() => window.__game && window.__game._die('barrier'));
  await page.waitForTimeout(2500);
  const overVisible = await page.locator('text=RUN AGAIN').count();
  if (!overVisible) problems.push('game over screen did not appear');
  log('game over screen shown');

  const stored = await page.evaluate(() => localStorage.getItem('neonrush.profile'));
  if (!stored) problems.push('profile not persisted to localStorage');
  log('profile persisted');

  // Shop opens and lists items.
  await page.click('text=SHOP');
  await page.waitForTimeout(500);
  const shopItems = await page.locator('.shop-item').count();
  log(`shop items: ${shopItems}`);
  if (shopItems < 5) problems.push(`shop rendered ${shopItems} items`);

  await page.click('text=Skins');
  await page.waitForTimeout(300);
  const skins = await page.locator('.skin').count();
  if (skins < 3) problems.push(`skins rendered ${skins}`);
  log(`skins: ${skins}`);

  await page.click('text=BACK');
  await page.waitForTimeout(400);

  await context.close();
}

// =========================================================================
// Mobile: touch play
// =========================================================================
{
  const context = await browser.newContext({ ...devices['iPhone 12'], hasTouch: true });
  const page = await context.newPage();
  watch(page, 'mobile');

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!document.querySelector('#ui-root .btn--primary'), { timeout: 15000 });

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) problems.push('horizontal overflow on mobile');
  log(`mobile layout ok (no overflow: ${!overflow})`);

  await page.tap('.btn--primary');
  await page.waitForTimeout(4200);

  // Swipe gestures on the canvas.
  const box = await page.locator('#game').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const swipe = async (dx, dy) => {
    await page.touchscreen.tap(cx, cy);       // ensure focus
    await page.evaluate(({ cx, cy, dx, dy }) => {
      const el = document.getElementById('game');
      const mk = (type, x, y) => new TouchEvent(type, {
        bubbles: true, cancelable: true,
        changedTouches: [new Touch({ identifier: 1, target: el, clientX: x, clientY: y })],
      });
      el.dispatchEvent(mk('touchstart', cx, cy));
      el.dispatchEvent(mk('touchmove', cx + dx, cy + dy));
      el.dispatchEvent(mk('touchend', cx + dx, cy + dy));
    }, { cx, cy, dx, dy });
    await page.waitForTimeout(300);
  };

  await swipe(-120, 0);
  await swipe(0, -120);
  await swipe(120, 0);
  await swipe(0, 120);
  await page.waitForTimeout(800);

  const mobileState = await page.evaluate(() => {
    const root = document.getElementById('ui-root');
    return root.querySelector('.hud__score')?.textContent || null;
  });
  log('mobile HUD score:', mobileState);
  if (!mobileState) problems.push('mobile HUD not rendering');

  await context.close();
}

await browser.close();

console.log('');
if (problems.length) {
  console.error(`FAIL: ${problems.length} problem(s)`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('PASS: game loads, plays and persists on desktop and mobile.');
