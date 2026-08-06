# NEON RUSH

An endless subway runner. Pseudo-3D canvas renderer, procedural audio, a
Python + SQLite backend for persistent leaderboards, and a shop/progression
loop. No build step, no npm dependencies at runtime, no external assets.

```
python run.py
```

Then play at <http://127.0.0.1:8000>. That is the whole setup - Python 3.10+
and a browser.

---

## Controls

|              | Desktop                    | Touch              |
| ------------ | -------------------------- | ------------------ |
| Change lane  | `<-` `->` / `A` `D`          | Swipe left / right |
| Jump         | `Up` / `W` / `Space`        | Swipe up, or tap   |
| Slide        | `Down` / `S`                  | Swipe down         |
| Pause        | `Esc` / `P`                | Pause button       |
| Mute         | `M`                        | Menu toggle        |

Gamepads work too (d-pad, left stick, A/B, Start).

---

## What is in the game

**Hazards** - barriers (jump), overhead gates (slide), pylons and parked
carriages (dodge, or land on a train roof for bonus coins), track gaps (jump),
drifting drones, and telegraphed oncoming express trains.

**Power-ups** - Magnet (vacuums coins), Shield (absorbs one hit, then smashes
through hazards), Turbo (speed boost + invulnerability), Score x2.

**Scoring** - distance + coins, multiplied by a combo chain that builds every
8 coins and decays if you stop collecting. Threading past a hazard at close
range scores a near-miss bonus.

**Progression** - coins bank after each run and buy upgrades (longer power-ups,
richer coins, a head start, hoverboards that survive one fatal hit) and
cosmetic skins. Three rotating missions grant coins and XP.

---

## Architecture

```
run.py                  launcher (host/port/db flags)
server/app/
  config.py             all tuning + the authoritative shop catalog
  schema.sql            SQLite schema
  db.py                 thread-local connections, WAL, transactions
  validation.py         anti-cheat plausibility envelope
  api.py                routing, auth, rate limiting
  server.py             HTTP server + static file serving
web/
  index.html            shell (canvas + React mount point)
  css/style.css         all UI chrome
  js/engine/            constants, util, camera, world, player,
                        particles, renderer, audio, input, game
  js/ui/                React components + App
  js/api.js             backend client with offline fallback
  js/missions.js        progression
  vendor/               React UMD builds (vendored, not fetched)
tools/                  dev utilities and test harnesses
tests/                  backend unit tests
```

### Design decisions worth knowing

**The canvas is not React-managed.** The `<canvas>` lives in `index.html` and
React only renders the overlay. A UI re-render can never remount the canvas or
interrupt the render loop.

**Fixed-timestep physics (120 Hz) with clamped frame time.** Jump arcs and
collisions are identical at 60 Hz and 144 Hz, and a backgrounded tab cannot
teleport the runner through an obstacle.

**Generation is fair by construction.** Rows are hand-authored templates, never
per-lane random rolls. Row spacing is measured in *seconds of reaction time* at
the current speed rather than metres, so speeding up makes the track denser but
never reduces thinking time below the budget. Full-width rows are always
clearable by a single jump or slide, two-lane blocks always leave a *reachable*
survivor, and while an express is sweeping a lane the generator only emits
jump/slide hazards so you can never be forced into it.

**The server never trusts the client.** Prices, upgrade caps and effects live
server-side. Each run gets a single-use token; at submission the reported
duration is checked against real elapsed wall-clock time, and distance, coins
and score are each bounded by what is physically reachable. Implausible runs
return `accepted: false` rather than an error - the player still sees their
score, it just does not rank.

**Offline-first.** Every read falls back to `localStorage`, every write updates
local state before syncing. Losing the network mid-session (or opening the game
with no server at all) degrades to local-only play with no lost progress.

**All audio is synthesised.** No audio files. The coin pitch climbs with your
combo and the music bed's filter and tempo track your speed.

---

## Testing

```bash
python -m unittest discover -s tests -v   # 25 backend tests
node tools/check_js.mjs                   # syntax + import graph
node tools/simulate.mjs 12 6000           # headless fairness check
node tools/smoke.mjs                      # real browser, desktop + mobile
python tools/ascii_check.py               # source hygiene
```

`simulate.mjs` is the interesting one: it boots the real engine under a DOM
stub and drives it with a bot that jumps, slides and paths between lanes. A
fair generator lets a competent bot run indefinitely, so a low survival rate
means unsolvable rows exist. It found four real bugs during development -
including a variable-jump-height rule that made barriers uncleanable by tap on
mobile, and a slide-cancel-on-lane-change that killed you under gates.

`smoke.mjs` loads the served game in headless Chromium, plays it with real
keyboard and synthetic touch events, and fails on any console error, page
error, failed request, or frame rate below 30.

## Server options

```bash
python run.py --host 0.0.0.0    # expose on the LAN to play on your phone
python run.py --port 9000       # scans upward if busy
python run.py --reset-db        # wipe scores and start fresh
python run.py -v                # log every request
```
