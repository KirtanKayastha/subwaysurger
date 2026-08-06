/**
 * Character animation capture.
 *
 * Renders the runner in each pose and writes PNG crops so the animation can be
 * eyeballed, plus a pixel-difference check that fails if consecutive run frames
 * are identical (i.e. the character is frozen).
 *
 *   node tools/anim_check.mjs [baseUrl]
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:8123';
const OUT = 'tools/anim';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newContext({ viewport: { width: 900, height: 620 } })
  .then((c) => c.newPage());

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!document.querySelector('.btn--primary'));

// A fresh browser profile lands on the name gate. Claim a throwaway name (no
// password) so the harness reaches the menu.
if (await page.locator('text=CHOOSE YOUR NAME').count()) {
  await page.fill('input[autocomplete="username"]', `AN${Date.now().toString().slice(-6)}`);
  await page.locator('button[type="submit"]').click();
  await page.waitForSelector('button:has-text("PLAY")', { timeout: 15000 });
}

await page.click('.btn--primary');
await page.waitForFunction(() => !!window.__game);

// Freeze the sim so we control exactly what is drawn, then pose the runner by
// hand and render single frames.
await page.evaluate(() => {
  const g = window.__game;
  g.stop();
  g.state = 'playing';
  g.countdown = 0;
  window.__draw = () => { g._buildHud(); g.renderer.render(g.renderState); };
});

/** Crop the region around the runner. */
const shot = (name) => page.screenshot({
  path: `${OUT}/${name}.png`,
  clip: { x: 300, y: 250, width: 300, height: 330 },
});

/** Mean absolute pixel difference between two canvas snapshots. */
const pixels = () => page.evaluate(() => {
  const c = document.getElementById('game');
  const t = document.createElement('canvas');
  t.width = 300; t.height = 330;
  t.getContext('2d').drawImage(c, 300 * (c.width / c.clientWidth), 250 * (c.height / c.clientHeight),
    300 * (c.width / c.clientWidth), 330 * (c.height / c.clientHeight), 0, 0, 300, 330);
  return Array.from(t.getContext('2d').getImageData(0, 0, 300, 330).data);
});

const diff = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]);
  return sum / (a.length / 4);
};

// --- run cycle: sample four phases -----------------------------------------
const frames = [];
for (let i = 0; i < 4; i++) {
  await page.evaluate((phase) => {
    const g = window.__game;
    const pl = g.player;
    pl.dead = false; pl.grounded = true; pl.ducking = false;
    pl.y = 0; pl.vy = 0; pl.duckBlend = 0; pl.squash = 0; pl.stretch = 0;
    pl.runCycle = phase;
    window.__draw();
  }, (i / 4) * Math.PI * 2);
  await shot(`run${i}`);
  frames.push(await pixels());
}

const runDiffs = [
  diff(frames[0], frames[1]),
  diff(frames[1], frames[2]),
  diff(frames[2], frames[3]),
];
console.log('  run-cycle frame diffs:', runDiffs.map((d) => d.toFixed(2)).join(', '));
if (runDiffs.every((d) => d < 0.5)) {
  errors.push('run animation appears static (frames nearly identical)');
}

// --- jump arc ---------------------------------------------------------------
for (const [name, vy, y] of [['jump_rise', 9, 1.2], ['jump_apex', 0, 2.0], ['jump_fall', -9, 1.2]]) {
  await page.evaluate(({ vy, y }) => {
    const g = window.__game, pl = g.player;
    pl.grounded = false; pl.ducking = false; pl.dead = false;
    pl.vy = vy; pl.y = y; pl.duckBlend = 0;
    pl.pitch = Math.max(-0.34, Math.min(0.42, -vy * 0.022));
    window.__draw();
  }, { vy, y });
  await shot(name);
}

// --- duck -------------------------------------------------------------------
for (const [name, blend] of [['duck_half', 0.5], ['duck_full', 1]]) {
  await page.evaluate((b) => {
    const g = window.__game, pl = g.player;
    pl.grounded = true; pl.ducking = true; pl.dead = false;
    pl.y = 0; pl.vy = 0; pl.duckBlend = b;
    window.__draw();
  }, blend);
  await shot(name);
}

// --- landing squash ---------------------------------------------------------
await page.evaluate(() => {
  const g = window.__game, pl = g.player;
  pl.grounded = true; pl.ducking = false; pl.dead = false;
  pl.y = 0; pl.vy = 0; pl.duckBlend = 0; pl.squash = 1;
  window.__draw();
});
await shot('land_squash');

// --- crash + hit flash ------------------------------------------------------
for (const [name, dt] of [['crash_0', 0.05], ['crash_1', 0.6]]) {
  await page.evaluate((t) => {
    const g = window.__game, pl = g.player;
    pl.dead = true; pl.deathTime = t; pl.hitFlash = t < 0.2 ? 1 : 0;
    pl.y = 0; pl.vy = 0;
    window.__draw();
  }, dt);
  await shot(name);
}

// The background (tunnel, rails, HUD) is far brighter than any per-pose
// difference, so measuring absolute pixels finds the scenery rather than the
// character. Instead, render each pose twice - once normally and once with the
// character suppressed - and diff the two. Whatever changes IS the character.
const silhouette = await page.evaluate(() => {
  const g = window.__game;
  const c = document.getElementById('game');
  const sx = c.width / c.clientWidth;
  const sy = c.height / c.clientHeight;
  const X = Math.round(300 * sx), Y = Math.round(250 * sy);
  const W = Math.round(300 * sx), H = Math.round(330 * sy);

  const grab = () => c.getContext('2d').getImageData(X, Y, W, H).data;

  /** Top-most row where the pose differs from the character-free plate. */
  const topOf = (pose) => {
    // Plate: identical frame with the body skipped.
    g.__hidePlayer = true;
    pose();
    const base = grab();
    g.__hidePlayer = false;
    pose();
    const shot = grab();

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const d = Math.abs(base[i] - shot[i])
          + Math.abs(base[i + 1] - shot[i + 1])
          + Math.abs(base[i + 2] - shot[i + 2]);
        if (d > 40) return y;
      }
    }
    return H;
  };

  const pl = g.player;
  const reset = () => {
    pl.dead = false; pl.grounded = true; pl.y = 0; pl.vy = 0;
    pl.squash = 0; pl.stretch = 0; pl.pitch = 0; pl.runCycle = 0.6;
  };

  const runTop = topOf(() => {
    reset(); pl.ducking = false; pl.duckBlend = 0; window.__draw();
  });
  const duckTop = topOf(() => {
    reset(); pl.ducking = true; pl.duckBlend = 1; window.__draw();
  });
  return { runTop, duckTop, H };
});

console.log(`  silhouette top: run=${silhouette.runTop} duck=${silhouette.duckTop}`);
if (silhouette.duckTop <= silhouette.runTop + 4) {
  errors.push(
    `duck pose is not visibly shorter (run top ${silhouette.runTop}, duck top ${silhouette.duckTop})`);
}

await browser.close();

console.log('');
if (errors.length) {
  console.error(`FAIL: ${errors.length} problem(s)`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log(`PASS: poses render and animate. Frames written to ${OUT}/`);
