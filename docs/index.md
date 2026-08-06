# NEON RUSH

An endless subway runner with a pseudo-3D canvas renderer, procedural audio, and a Python + SQLite/PostgreSQL backend for persistent leaderboards and progression. No build step, no runtime npm dependencies, no external assets.

---

## Tech Stack

**Backend**
- Python 3.10+ (standard library `http.server`, `threading`)
- SQLite (default) or PostgreSQL / Neon via `psycopg2-binary`
- SQL dialect abstraction layer in `driver.py` for dual-backend support

**Frontend**
- HTML5 `<canvas>` for rendering (not React-managed)
- Vanilla JavaScript modules (ESM, no bundler)
- React (UMD builds vendored, not fetched at runtime) for UI overlay only
- Web Audio API for procedural sound synthesis
- No build step, no npm dependencies at runtime

**Audio**
- Procedurally generated via Web Audio API
- No audio files, no external assets

**Testing**
- Python `unittest` for backend tests
- Node.js tooling for frontend validation (`simulate.mjs`, `smoke.mjs`)

**Deployment**
- Docker (`python:3.11-slim`, non-root user)
- Heroku / PaaS via Procfile
- Environment-driven config (`PORT`, `HOST`, `DATABASE_URL`)

---

## Quick Start

```bash
python run.py
```

Then open <http://127.0.0.1:8000>.

Requirements: Python 3.10+ and a modern browser.

---

## Game Features

**Hazards** - barriers (jump), overhead gates (slide), pylons and parked carriages (dodge, or land on a train roof for bonus coins), track gaps (jump), drifting drones, and telegraphed oncoming express trains.

**Power-ups** - Magnet (vacuums coins), Shield (absorbs one hit, then smashes through hazards), Turbo (speed boost + invulnerability), Score x2.

**Scoring** - distance + coins, multiplied by a combo chain that builds every 8 coins and decays if you stop collecting. Threading past a hazard at close range scores a near-miss bonus.

**Progression** - coins bank after each run and buy upgrades (longer power-ups, richer coins, a head start, hoverboards that survive one fatal hit) and cosmetic skins. Three rotating missions grant coins and XP.

---

## Architecture

```
run.py                  launcher (host/port/db flags)
server/app/
  config.py             all tuning + the authoritative shop catalog
  schema.sql            database schema
  driver.py             SQL dialect abstraction (SQLite / PostgreSQL)
  db.py                 database access layer (driver-agnostic)
  passwords.py          password hashing (bcrypt / scrypt / pbkdf2)
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

### Key Design Decisions

**The canvas is not React-managed.** The `<canvas>` lives in `index.html` and React only renders the overlay. A UI re-render can never remount the canvas or interrupt the render loop.

**Fixed-timestep physics (120 Hz) with clamped frame time.** Jump arcs and collisions are identical at 60 Hz and 144 Hz, and a backgrounded tab cannot teleport the runner through an obstacle.

**Generation is fair by construction.** Rows are hand-authored templates, never per-lane random rolls. Row spacing is measured in seconds of reaction time at the current speed rather than metres, so speeding up makes the track denser but never reduces thinking time below the budget. Full-width rows are always clearable by a single jump or slide, two-lane blocks always leave a reachable survivor, and while an express is sweeping a lane the generator only emits jump/slide hazards so you can never be forced into it.

**The server never trusts the client.** Prices, upgrade caps and effects live server-side. Each run gets a single-use token; at submission the reported duration is checked against real elapsed wall-clock time, and distance, coins and score are each bounded by what is physically reachable. Implausible runs return `accepted: false` rather than an error - the player still sees their score, it just does not rank.

**Offline-first.** Every read falls back to `localStorage`, every write updates local state before syncing. Losing the network mid-session (or opening the game with no server at all) degrades to local-only play with no lost progress.

**All audio is synthesised.** No audio files. The coin pitch climbs with your combo and the music bed's filter and tempo track your speed.

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

## Backend API

All endpoints are prefixed with `/api/`. CORS is enabled for cross-origin clients.

### Public Endpoints

| Method | Path                   | Description                                      |
|--------|------------------------|--------------------------------------------------|
| GET    | `/api/health`          | Server version and current time                  |
| GET    | `/api/config`          | Shop catalog, skin catalog, physics constants     |
| GET    | `/api/leaderboard`     | `?limit=20&window=all|day|week&mode=best|runs`  |
| GET    | `/api/stats`           | Aggregate server statistics                      |
| GET    | `/api/name-available`  | `?name=X` - check if a name is taken             |
| POST   | `/api/register`        | `{"name": "X"}` - claim a name, get token        |
| POST   | `/api/claim-name`      | Claim an unused name with optional password      |
| POST   | `/api/verify-name`     | Sign back in with name + password, get new token |

### Authenticated Endpoints

Require `Authorization: Bearer <token>` header.

| Method | Path                      | Description                                  |
|--------|---------------------------|----------------------------------------------|
| GET    | `/api/me`                 | Current player profile                       |
| POST   | `/api/me/name`            | Change display name                          |
| POST   | `/api/me/progress`        | Save opaque client progress blob             |
| POST   | `/api/me/skin`            | Equip an owned skin                          |
| GET    | `/api/me/scores`          | Recent scores for the player                 |
| POST   | `/api/run/start`          | Begin a run, get a one-shot run token        |
| POST   | `/api/run/submit`         | Submit a finished run for validation         |
| POST   | `/api/shop/buy`           | Purchase an upgrade tier                     |
| POST   | `/api/shop/skin`          | Purchase a cosmetic skin                     |
| POST   | `/api/shop/consume`       | Consume a hoverboard (or other consumable)   |

### Authentication

There are no passwords on sign-up by default. The bearer token returned by `/api/register` is the credential. Players can optionally add a password via `/api/claim-name` or `/api/verify-name` to lock their name. Legacy accounts without passwords can adopt one on first return.

Token rotation: every successful sign-in issues a fresh token and invalidates the old one. Wrong passwords and unknown names return the same `invalid_password` error to prevent user enumeration.

---

## Database

### SQLite (default for local development)

The server stores data in `data/neonrush.sqlite3` by default. WAL mode is enabled for concurrent reads during writes. The database file and its WAL sidecars are excluded from the Docker image via `.dockerignore`.

### PostgreSQL / Neon (deployment)

Set `DATABASE_URL=postgresql://...` or `postgres://...` to use PostgreSQL. Neon, Render, Supabase, Heroku Postgres, and any standard Postgres host work. The server requires `psycopg2-binary` when running in Postgres mode; startup fails loudly if it is missing.

The `server/app/driver.py` module provides a SQL dialect abstraction layer:

- `AUTOINCREMENT` -> `SERIAL`
- `INSERT OR IGNORE` -> `ON CONFLICT DO NOTHING`
- `REAL` -> `DOUBLE PRECISION`
- `COLLATE NOCASE` removal
- `MAX(a, b)` -> `GREATEST(a, b)`
- PRAGMA stripping
- Expression index on `LOWER(name)` for case-insensitive uniqueness

Thread-local connections with stale-detection and automatic reconnect are handled in `server/app/db.py`.

### Schema

See `server/app/schema.sql`. The schema is applied via `executescript` on startup and is idempotent. Migrations for password columns and unique name indexes run automatically if the database already exists.

---

## Configuration

Environment variables and defaults:

| Variable      | Default                    | Description                                      |
|---------------|----------------------------|--------------------------------------------------|
| `PORT`        | `8000`                     | Bind port                                        |
| `HOST`        | `127.0.0.1`                | Bind address; auto-binds `0.0.0.0` when `PORT` is set |
| `DATABASE_URL`| `sqlite:///./data/neonrush.sqlite3` | Database target. Accepts PostgreSQL (`postgresql://` or `postgres://`), SQLite URLs (`sqlite:///path`), or bare filesystem paths |
| `NEONRUSH_DB` | *(none)*                   | Explicit SQLite path; takes precedence over `DATABASE_URL` when set. Ignored for PostgreSQL URLs |

All tuning constants live in `server/app/config.py`:

- `MAX_BODY_BYTES` - 64 KiB request body limit
- `RATE_LIMIT_BURST` / `RATE_LIMIT_PER_SEC` - per-IP token bucket
- `TOKEN_BYTES` - 32 bytes of entropy for player tokens
- `NAME_MIN_LEN` / `NAME_MAX_LEN` - 1-16 characters
- `RUN_TOKEN_TTL_SEC` - 6 hours
- `RUN_TOKEN_PRUNE_SEC` - 24 hours
- `PHYSICS` - anti-cheat plausibility ceiling (max speed, max coins, max distance, etc.)
- `COIN_BANK_RATE` - 1.0 (100% of collected coins banked)
- `COIN_DISTANCE_BONUS_PER_KM` - 40 bonus coins per km

---

## Testing

```bash
python -m unittest discover -s tests -v
```

### Frontend Checks

```bash
node tools/check_js.mjs                   # syntax + import graph
node tools/simulate.mjs 12 6000           # headless fairness check
node tools/smoke.mjs                      # real browser, desktop + mobile
python tools/ascii_check.py               # source hygiene
```

`simulate.mjs` boots the real engine under a DOM stub and drives it with a bot. A fair generator lets a competent bot run indefinitely, so a low survival rate means unsolvable rows exist. It found four real bugs during development - including a variable-jump-height rule that made barriers uncleanable by tap on mobile, and a slide-cancel-on-lane-change that killed you under gates.

`smoke.mjs` loads the served game in headless Chromium, plays it with real keyboard and synthetic touch events, and fails on any console error, page error, failed request, or frame rate below 30.

---

## Server Options

```bash
python run.py --host 0.0.0.0    # expose on the LAN to play on your phone
python run.py --port 9000       # scans upward if busy
python run.py --no-browser      # just serve, no auto-open
python run.py --reset-db        # wipe scores and start fresh
python run.py -v                # log every request
```

---

## Deployment

### Docker

```bash
docker build -t neonrush .
docker run -p 8080:8080 -v neonrush-data:/app/data neonrush
```

The image is built on `python:3.11-slim` and runs as a non-root `neon` user. The `/app/data` volume preserves the SQLite database across container restarts.

For PostgreSQL deployments (Neon, Render, Supabase, etc.):

```bash
docker run -p 8080:8080 \
  -e DATABASE_URL=postgresql://user:pass@host/db \
  neonrush
```

### Heroku / PaaS

```bash
heroku create
git push heroku main
```

The `Procfile` declares `web: python run.py`. The server reads `$PORT` and binds `0.0.0.0` automatically. Set `DATABASE_URL` to the platform's provided PostgreSQL connection string (Heroku, Render, Fly.io, etc.).

---

## File Reference

| Path                          | Purpose                                              |
|-------------------------------|------------------------------------------------------|
| `run.py`                      | Launcher with CLI args and env-var support           |
| `server/app/server.py`        | HTTP server, static file serving, CORS               |
| `server/app/api.py`           | Route table and handler implementations              |
| `server/app/db.py`            | Database access layer (thread-local, driver-agnostic)|
| `server/app/driver.py`        | SQL dialect abstraction (SQLite / PostgreSQL)        |
| `server/app/schema.sql`       | Database schema                                      |
| `server/app/config.py`        | All tuning constants, shop catalog, physics caps     |
| `server/app/validation.py`    | Run submission anti-cheat validation                 |
| `server/app/passwords.py`     | Password hashing backends                            |
| `web/index.html`              | Canvas shell + React mount point                     |
| `web/css/style.css`           | UI chrome                                            |
| `web/js/engine/`              | Game engine (physics, rendering, audio, input)       |
| `web/js/ui/`                  | React UI components                                  |
| `web/js/api.js`               | Backend client with offline fallback                 |
| `tests/test_backend.py`       | Backend unit tests                                   |
| `tools/simulate.mjs`          | Headless bot-driven fairness test                    |
| `tools/smoke.mjs`             | Headless Chromium smoke test                         |
