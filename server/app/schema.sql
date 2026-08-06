-- NEON RUSH schema.
--
-- Design notes:
--  * Every table carries integer epoch-millisecond timestamps (created_ms /
--    updated_ms) so the API can order and prune without date parsing.
--  * `players.token_hash` stores a SHA-256 of the client's bearer token; the
--    raw token is only ever seen once, at registration time.
--  * `scores` is append-only: it is the authoritative run history. The
--    leaderboard is a query over it rather than a mutable table, which keeps
--    ranking honest and lets us recompute at any time.

PRAGMA foreign_keys = ON;

-- Registered players. A "player" is created transparently on first launch.
CREATE TABLE IF NOT EXISTS players (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    public_id    TEXT    NOT NULL UNIQUE,   -- opaque id shared with clients
    token_hash   TEXT    NOT NULL UNIQUE,   -- sha256(bearer token)
    name         TEXT    NOT NULL,
    password_hash TEXT   NOT NULL DEFAULT '', -- '' = legacy, no password set
    coins        INTEGER NOT NULL DEFAULT 0,     -- banked, spendable currency
    total_coins  INTEGER NOT NULL DEFAULT 0,     -- lifetime collected
    best_score   INTEGER NOT NULL DEFAULT 0,
    best_distance REAL   NOT NULL DEFAULT 0,
    runs         INTEGER NOT NULL DEFAULT 0,
    play_ms      INTEGER NOT NULL DEFAULT 0,
    skin         TEXT    NOT NULL DEFAULT 'cyan',
    progress     TEXT    NOT NULL DEFAULT '{}', -- opaque client blob (missions etc.)
    created_ms   INTEGER NOT NULL,
    updated_ms   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_players_best ON players(best_score DESC);

-- NOTE: display names are also UNIQUE (case-insensitively), but that index is
-- created by Database._migrate_unique_names() rather than here. Existing
-- databases predate the constraint and contain duplicate default names, so the
-- duplicates must be resolved before the index can be built.

-- Purchased upgrade tiers / consumable stock, one row per (player, item).
CREATE TABLE IF NOT EXISTS upgrades (
    player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    item_id    TEXT    NOT NULL,
    level      INTEGER NOT NULL DEFAULT 0,
    updated_ms INTEGER NOT NULL,
    PRIMARY KEY (player_id, item_id)
);

-- Cosmetic skins the player owns.
CREATE TABLE IF NOT EXISTS skins (
    player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    skin_id    TEXT    NOT NULL,
    created_ms INTEGER NOT NULL,
    PRIMARY KEY (player_id, skin_id)
);

-- Short-lived run tokens. Issued at run start, redeemed exactly once at
-- submit time. `started_ms` lets the server cross-check the reported
-- duration against real wall-clock time.
CREATE TABLE IF NOT EXISTS runs (
    token      TEXT    PRIMARY KEY,
    player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    started_ms INTEGER NOT NULL,
    used_ms    INTEGER,                     -- NULL until redeemed
    seed       INTEGER NOT NULL             -- level seed handed to the client
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_ms);

-- Append-only run results.
CREATE TABLE IF NOT EXISTS scores (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id   INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,           -- denormalised for fast boards
    score       INTEGER NOT NULL,
    coins       INTEGER NOT NULL,
    distance    REAL    NOT NULL,
    duration_ms INTEGER NOT NULL,
    best_combo  INTEGER NOT NULL DEFAULT 0,
    created_ms  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scores_score   ON scores(score DESC, created_ms ASC);
CREATE INDEX IF NOT EXISTS idx_scores_player  ON scores(player_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_scores_created ON scores(created_ms DESC);

-- Simple key/value bag for schema version and global counters.
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
