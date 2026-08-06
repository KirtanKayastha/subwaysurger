"""
Persistence layer.

Supports two backends behind one API (see :mod:`driver`):

* **PostgreSQL** when ``DATABASE_URL`` names one - the deployed configuration.
* **SQLite** otherwise - the zero-dependency default, and what the test-suite
  uses via ``:memory:``.

Structure worth knowing:

* **Thread-local connections.** ``http.server``'s threading mixin handles each
  request on its own thread, and neither driver is safe to share across
  threads. Each thread lazily opens (and reuses) its own connection.
* **A ``tx()`` context manager** for atomic multi-statement work such as
  "check balance, deduct coins, bump upgrade level".
* **One SQL dialect at the call sites.** :mod:`driver` translates to
  PostgreSQL where the two differ.

All timestamps are epoch milliseconds (integers) for easy JSON transport.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import secrets
import threading
import time
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional

from . import config
from . import driver

SCHEMA_VERSION = "3"

#: Columns that must hold 64-bit values, as ``(table, column)``.
#:
#: Epoch-millisecond timestamps (~1.8e12) and lifetime counters both overflow
#: PostgreSQL's 4-byte INTEGER, whose ceiling is 2_147_483_647. schema.sql now
#: declares them BIGINT, but that only helps a database being created for the
#: first time - see :meth:`Database._migrate_widen_integers`.
#:
#: Primary keys are deliberately absent. Widening a column that a foreign key
#: references forces PostgreSQL to revalidate the constraint, and an int8
#: foreign key referencing an int4 key is legal anyway, so leaving the existing
#: SERIAL columns alone is the lower-risk choice. Fresh databases get BIGSERIAL
#: from the schema regardless.
_BIGINT_COLUMNS: tuple[tuple[str, str], ...] = (
    ("players", "coins"),
    ("players", "total_coins"),
    ("players", "best_score"),
    ("players", "runs"),
    ("players", "play_ms"),
    ("players", "created_ms"),
    ("players", "updated_ms"),
    ("upgrades", "player_id"),
    ("upgrades", "level"),
    ("upgrades", "updated_ms"),
    ("skins", "player_id"),
    ("skins", "created_ms"),
    ("runs", "player_id"),
    ("runs", "started_ms"),
    ("runs", "used_ms"),
    ("runs", "seed"),
    ("scores", "player_id"),
    ("scores", "score"),
    ("scores", "coins"),
    ("scores", "duration_ms"),
    ("scores", "best_combo"),
    ("scores", "created_ms"),
)


class NameTakenError(Exception):
    """Raised when a display name is already claimed by another player."""

    def __init__(self, name: str) -> None:
        super().__init__(f"name already taken: {name}")
        self.name = name


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def now_ms() -> int:
    """Current time as epoch milliseconds."""
    return int(time.time() * 1000)


def hash_token(token: str) -> str:
    """Hash a bearer token for at-rest storage."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_token() -> str:
    """Generate a fresh URL-safe bearer token."""
    return secrets.token_urlsafe(config.TOKEN_BYTES)


def new_public_id() -> str:
    """Generate a short opaque public player id."""
    return secrets.token_hex(8)


class Database:
    """A small, thread-safe facade over PostgreSQL or a single SQLite file."""

    def __init__(self, path: Optional[os.PathLike | str] = None) -> None:
        raw = str(path) if path is not None else None

        #: True when the backend is PostgreSQL.
        self.postgres = driver.is_postgres_url(raw)

        if self.postgres:
            # For PostgreSQL `target` is the connection URL, not a filesystem
            # path, so no directory handling applies.
            self.target = raw
            self.path = None
        else:
            self.path = Path(raw) if raw else config.DEFAULT_DB_PATH
            self.target = str(self.path)
            # ":memory:" is used by the test-suite; skip directory creation.
            if self.target != ":memory:":
                self.path.parent.mkdir(parents=True, exist_ok=True)

        self._local = threading.local()
        # Serialises writes. Both backends can handle concurrent writers, but
        # an explicit lock gives clearer semantics for the read-modify-write
        # sequences used by purchases.
        self._write_lock = threading.RLock()
        # An in-memory SQLite database only survives while a connection is
        # open, so hold one open for the lifetime of the object in that mode.
        self._keepalive: Optional[driver.Connection] = None
        if not self.postgres and self.target == ":memory:":
            self._keepalive = self._new_connection()
        self.init_schema()

    # -- connection management ---------------------------------------------

    def _new_connection(self) -> driver.Connection:
        return driver.connect(self.target, postgres=self.postgres)

    @property
    def conn(self) -> driver.Connection:
        """
        The calling thread's connection, opened on first use.

        A cached connection is discarded and replaced if the server has closed
        it. Hosted PostgreSQL drops idle connections, and a worker thread can
        sit idle between requests for far longer than that timeout.
        """
        conn = getattr(self._local, "conn", None)
        if conn is not None and conn.stale:
            conn.close()
            conn = None
        if conn is None:
            conn = self._new_connection()
            self._local.conn = conn
        return conn

    @contextlib.contextmanager
    def tx(self) -> Iterator[driver.Connection]:
        """
        Run a block inside an exclusive transaction.

        Commits on success, rolls back on any exception. Held under
        ``_write_lock`` so read-modify-write logic is race-free.
        """
        with self._write_lock:
            conn = self.conn
            try:
                conn.begin()
                yield conn
            except BaseException:
                conn.rollback()
                raise
            else:
                conn.commit()

    def close(self) -> None:
        """Close this thread's connection (and the in-memory keepalive)."""
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None
        if self._keepalive is not None:
            self._keepalive.close()
            self._keepalive = None

    # -- schema -------------------------------------------------------------

    def init_schema(self) -> None:
        """Create tables if absent and stamp the schema version."""
        sql = (Path(__file__).with_name("schema.sql")).read_text(encoding="utf-8")
        with self.tx() as conn:
            conn.executescript(sql)
            conn.execute(
                "INSERT INTO meta(key, value) VALUES('schema_version', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (SCHEMA_VERSION,),
            )
        self._migrate_widen_integers()
        self._migrate_unique_names()
        self._migrate_password_column()

    def _migrate_widen_integers(self) -> None:
        """
        Widen 4-byte INTEGER columns to BIGINT on PostgreSQL.

        schema.sql declares every timestamp and counter BIGINT, but
        ``CREATE TABLE IF NOT EXISTS`` leaves an already-existing table exactly
        as it found it. A deployment created before that fix therefore still
        has int4 ``created_ms`` / ``updated_ms`` columns, so every INSERT of an
        epoch-millisecond value (~1.8e12 against a 2_147_483_647 ceiling) fails
        with ``integer out of range``. That is the 500 on ``/api/claim-name``:
        the table exists, the server starts, ``/api/health`` is fine, and only
        writes blow up.

        Idempotent - it only touches columns still reported as ``integer``, so
        it is a single catalogue query on every subsequent boot.

        SQLite needs nothing here: it stores all integers as 64-bit regardless
        of the declared type name, which is exactly why this bug was invisible
        in local development and in the test-suite.
        """
        if not self.postgres:
            return

        with self.tx() as conn:
            narrow = {
                (row[0], row[1])
                for row in conn.execute(
                    "SELECT table_name, column_name "
                    "  FROM information_schema.columns "
                    " WHERE table_schema = current_schema() "
                    "   AND data_type = 'integer'"
                ).fetchall()
            }
            for table, column in _BIGINT_COLUMNS:
                if (table, column) in narrow:
                    # Identifiers are literals from _BIGINT_COLUMNS, never user
                    # input, so interpolation here cannot be injected into.
                    conn.execute(
                        f"ALTER TABLE {table} ALTER COLUMN {column} TYPE BIGINT"
                    )

    def _migrate_password_column(self) -> None:
        """
        Add ``players.password_hash`` to databases created before passwords.

        Existing players keep an empty hash, which means "no password set":
        they may claim one on their next return visit rather than being locked
        out of their own progress.
        """
        with self.tx() as conn:
            if "password_hash" not in conn.column_names("players"):
                conn.execute(
                    "ALTER TABLE players ADD COLUMN password_hash TEXT NOT NULL DEFAULT ''"
                )

    def _migrate_unique_names(self) -> None:
        """
        Make display names case-insensitively unique.

        Databases created before names were claimable contain many players
        sharing the default name, so a UNIQUE index cannot simply be declared
        in schema.sql - it would fail to build and take the server down on
        startup. Duplicates are resolved first, oldest player keeping the bare
        name, then the index is created.

        Idempotent: once the index exists this is a single cheap query.
        """
        with self.tx() as conn:
            if conn.index_exists("idx_players_name_unique"):
                return

            dupes = conn.execute(
                """
                SELECT LOWER(name) AS lname, COUNT(*) AS n
                  FROM players
                 GROUP BY LOWER(name)
                HAVING COUNT(*) > 1
                """
            ).fetchall()

            for dupe in dupes:
                # Oldest row keeps the name; the rest get a numeric suffix,
                # truncated so the result still fits NAME_MAX_LEN.
                rows = conn.execute(
                    "SELECT id, name FROM players WHERE LOWER(name) = ? "
                    "ORDER BY created_ms ASC, id ASC",
                    (dupe["lname"],),
                ).fetchall()
                for index, row in enumerate(rows[1:], start=2):
                    base = str(row["name"])
                    for attempt in range(index, index + 10000):
                        suffix = str(attempt)
                        trimmed = base[: max(1, config.NAME_MAX_LEN - len(suffix))]
                        candidate = f"{trimmed}{suffix}"
                        clash = conn.execute(
                            "SELECT 1 FROM players WHERE LOWER(name) = LOWER(?) LIMIT 1",
                            (candidate,),
                        ).fetchone()
                        if not clash:
                            conn.execute(
                                "UPDATE players SET name = ?, updated_ms = ? WHERE id = ?",
                                (candidate, now_ms(), row["id"]),
                            )
                            conn.execute(
                                "UPDATE scores SET name = ? WHERE player_id = ?",
                                (candidate, row["id"]),
                            )
                            break

            # Case-insensitive uniqueness is expressed differently: SQLite uses
            # a COLLATE NOCASE column, PostgreSQL an expression index. Both
            # produce the same constraint, so the two spellings are explicit
            # here rather than being run through the translator.
            if self.postgres:
                conn.execute(
                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_players_name_unique "
                    "ON players (LOWER(name))"
                )
            else:
                conn.execute(
                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_players_name_unique "
                    "ON players(name COLLATE NOCASE)"
                )

    # -- generic query helpers ---------------------------------------------

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[Any]:
        return self.conn.execute(sql, tuple(params)).fetchall()

    def query_one(self, sql: str, params: Iterable[Any] = ()) -> Optional[Any]:
        return self.conn.execute(sql, tuple(params)).fetchone()

    # ======================================================================
    # Players
    # ======================================================================

    def name_taken(self, name: str, *, exclude_player_id: Optional[int] = None) -> bool:
        """
        Is this display name already claimed by someone else?

        Case-insensitive, matching the unique index. Callers that then write
        must re-check inside the same transaction; this is for cheap read-only
        probes such as the availability endpoint.
        """
        sql = "SELECT 1 FROM players WHERE LOWER(name) = LOWER(?)"
        params: list[Any] = [name]
        if exclude_player_id is not None:
            sql += " AND id != ?"
            params.append(exclude_player_id)
        return self.query_one(sql + " LIMIT 1", params) is not None

    def create_player(self, name: str, password_hash: str = "") -> tuple[dict, str]:
        """
        Register a new player, claiming ``name``.

        Returns ``(player_dict, raw_token)``. The raw token is shown to the
        caller exactly once; only its hash is persisted.

        Raises :class:`NameTakenError` if the name is already claimed. The
        check runs inside the write transaction, so two clients racing for the
        same name cannot both win.
        """
        token = new_token()
        ts = now_ms()
        with self.tx() as conn:
            clash = conn.execute(
                "SELECT 1 FROM players WHERE LOWER(name) = LOWER(?) LIMIT 1", (name,)
            ).fetchone()
            if clash:
                raise NameTakenError(name)
            pid = conn.insert_id(
                """
                INSERT INTO players
                    (public_id, token_hash, name, password_hash, created_ms, updated_ms)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (new_public_id(), hash_token(token), name, password_hash, ts, ts),
            )
            # Everyone starts owning the default skin.
            conn.execute(
                "INSERT OR IGNORE INTO skins(player_id, skin_id, created_ms) VALUES(?,?,?)",
                (pid, "cyan", ts),
            )
            row = conn.execute("SELECT * FROM players WHERE id = ?", (pid,)).fetchone()
        return self._player_dict(row), token

    def player_by_name(self, name: str) -> Optional[dict]:
        """Look up a player by display name (case-insensitive), or ``None``."""
        row = self.query_one(
            "SELECT * FROM players WHERE LOWER(name) = LOWER(?) LIMIT 1", (name,)
        )
        return self._player_dict(row) if row else None

    def password_hash_for(self, player_id: int) -> str:
        """Stored password hash, or ``''`` when the player has none."""
        row = self.query_one(
            "SELECT password_hash FROM players WHERE id = ?", (player_id,)
        )
        return str(row["password_hash"]) if row and row["password_hash"] else ""

    def set_password_hash(self, player_id: int, password_hash: str) -> None:
        """Attach a password to an account that has none (or replace it)."""
        with self.tx() as conn:
            conn.execute(
                "UPDATE players SET password_hash = ?, updated_ms = ? WHERE id = ?",
                (password_hash, now_ms(), player_id),
            )

    def rotate_token(self, player_id: int) -> str:
        """
        Issue a fresh bearer token for a player and invalidate the old one.

        Called after a successful sign-in so each browser gets its own valid
        credential without the previous device's token leaking between them.
        """
        token = new_token()
        with self.tx() as conn:
            conn.execute(
                "UPDATE players SET token_hash = ?, updated_ms = ? WHERE id = ?",
                (hash_token(token), now_ms(), player_id),
            )
        return token

    def player_by_token(self, token: str) -> Optional[dict]:
        """Look up a player by raw bearer token, or ``None``."""
        if not token:
            return None
        row = self.query_one(
            "SELECT * FROM players WHERE token_hash = ?", (hash_token(token),)
        )
        return self._player_dict(row) if row else None

    def player_by_id(self, player_id: int) -> Optional[dict]:
        row = self.query_one("SELECT * FROM players WHERE id = ?", (player_id,))
        return self._player_dict(row) if row else None

    def rename_player(self, player_id: int, name: str) -> None:
        """
        Update a display name (also backfills historical score rows).

        Raises :class:`NameTakenError` if another player already holds the
        name. Re-checked inside the transaction so concurrent renames cannot
        both succeed.
        """
        with self.tx() as conn:
            clash = conn.execute(
                "SELECT 1 FROM players WHERE LOWER(name) = LOWER(?) AND id != ? LIMIT 1",
                (name, player_id),
            ).fetchone()
            if clash:
                raise NameTakenError(name)
            conn.execute(
                "UPDATE players SET name = ?, updated_ms = ? WHERE id = ?",
                (name, now_ms(), player_id),
            )
            # Keep the denormalised leaderboard name in sync.
            conn.execute("UPDATE scores SET name = ? WHERE player_id = ?", (name, player_id))

    def set_skin(self, player_id: int, skin_id: str) -> bool:
        """Equip an owned skin. Returns False if the player does not own it."""
        owned = self.query_one(
            "SELECT 1 FROM skins WHERE player_id = ? AND skin_id = ?", (player_id, skin_id)
        )
        if not owned:
            return False
        with self.tx() as conn:
            conn.execute(
                "UPDATE players SET skin = ?, updated_ms = ? WHERE id = ?",
                (skin_id, now_ms(), player_id),
            )
        return True

    def save_progress(self, player_id: int, blob: dict) -> None:
        """Persist the opaque client-side progress blob (missions, stats...)."""
        text = json.dumps(blob, separators=(",", ":"))[: config.MAX_PROGRESS_BYTES]
        with self.tx() as conn:
            conn.execute(
                "UPDATE players SET progress = ?, updated_ms = ? WHERE id = ?",
                (text, now_ms(), player_id),
            )

    @staticmethod
    def _player_dict(row: Optional[Any]) -> Optional[dict]:
        """Convert a ``players`` row into a JSON-friendly dict."""
        if row is None:
            return None
        try:
            progress = json.loads(row["progress"]) if row["progress"] else {}
        except (ValueError, TypeError):
            progress = {}
        return {
            "id": row["id"],
            "publicId": row["public_id"],
            "name": row["name"],
            "coins": row["coins"],
            "totalCoins": row["total_coins"],
            "bestScore": row["best_score"],
            "bestDistance": row["best_distance"],
            "runs": row["runs"],
            "playMs": row["play_ms"],
            "skin": row["skin"],
            "progress": progress,
            "createdMs": row["created_ms"],
        }

    # ======================================================================
    # Upgrades & skins
    # ======================================================================

    def upgrades_for(self, player_id: int) -> dict[str, int]:
        rows = self.query(
            "SELECT item_id, level FROM upgrades WHERE player_id = ?", (player_id,)
        )
        return {r["item_id"]: r["level"] for r in rows}

    def skins_for(self, player_id: int) -> list[str]:
        rows = self.query(
            "SELECT skin_id FROM skins WHERE player_id = ? ORDER BY created_ms", (player_id,)
        )
        return [r["skin_id"] for r in rows]

    def add_coins(self, player_id: int, amount: int) -> int:
        """Credit coins (also bumping the lifetime counter). Returns balance."""
        amount = max(0, int(amount))
        with self.tx() as conn:
            conn.execute(
                """
                UPDATE players
                   SET coins = coins + ?, total_coins = total_coins + ?, updated_ms = ?
                 WHERE id = ?
                """,
                (amount, amount, now_ms(), player_id),
            )
            row = conn.execute("SELECT coins FROM players WHERE id = ?", (player_id,)).fetchone()
        return int(row["coins"]) if row else 0

    def purchase(self, player_id: int, item_id: str) -> dict:
        """
        Attempt to buy the next tier of ``item_id``.

        Price and level caps come from :data:`config.SHOP_CATALOG`, never from
        the client. The balance check and level bump share one transaction so
        concurrent requests cannot double-spend.

        Returns ``{"ok": True, "level":..., "coins":..., "spent":...}`` or
        ``{"ok": False, "error": "<reason>"}``.
        """
        catalog = config.shop_index()
        item = catalog.get(item_id)
        if item is None:
            return {"ok": False, "error": "unknown_item"}

        with self.tx() as conn:
            prow = conn.execute(
                "SELECT coins FROM players WHERE id = ?", (player_id,)
            ).fetchone()
            if prow is None:
                return {"ok": False, "error": "no_player"}
            balance = int(prow["coins"])

            lrow = conn.execute(
                "SELECT level FROM upgrades WHERE player_id = ? AND item_id = ?",
                (player_id, item_id),
            ).fetchone()
            level = int(lrow["level"]) if lrow else 0

            is_consumable = item["levels"] == 0
            if is_consumable:
                if level >= int(item.get("max_stock", 9)):
                    return {"ok": False, "error": "stock_full"}
            elif level >= item["levels"]:
                return {"ok": False, "error": "max_level"}

            price = config.price_for(item, level)
            if balance < price:
                return {"ok": False, "error": "insufficient_coins", "price": price}

            ts = now_ms()
            conn.execute(
                "UPDATE players SET coins = coins - ?, updated_ms = ? WHERE id = ?",
                (price, ts, player_id),
            )
            conn.execute(
                """
                INSERT INTO upgrades(player_id, item_id, level, updated_ms)
                VALUES(?,?,?,?)
                ON CONFLICT(player_id, item_id)
                DO UPDATE SET level = level + 1, updated_ms = excluded.updated_ms
                """,
                (player_id, item_id, 1, ts),
            )
            new_level = level + 1
            new_balance = balance - price

        return {"ok": True, "itemId": item_id, "level": new_level,
                "coins": new_balance, "spent": price}

    def buy_skin(self, player_id: int, skin_id: str) -> dict:
        """Purchase a cosmetic skin (one-time unlock) and equip it."""
        skins = config.skin_index()
        skin = skins.get(skin_id)
        if skin is None:
            return {"ok": False, "error": "unknown_skin"}

        with self.tx() as conn:
            owned = conn.execute(
                "SELECT 1 FROM skins WHERE player_id = ? AND skin_id = ?",
                (player_id, skin_id),
            ).fetchone()
            if owned:
                conn.execute(
                    "UPDATE players SET skin = ?, updated_ms = ? WHERE id = ?",
                    (skin_id, now_ms(), player_id),
                )
                row = conn.execute(
                    "SELECT coins FROM players WHERE id = ?", (player_id,)
                ).fetchone()
                return {"ok": True, "skinId": skin_id, "coins": int(row["coins"]),
                        "spent": 0, "equipped": True}

            prow = conn.execute(
                "SELECT coins FROM players WHERE id = ?", (player_id,)
            ).fetchone()
            if prow is None:
                return {"ok": False, "error": "no_player"}
            balance = int(prow["coins"])
            price = int(skin["price"])
            if balance < price:
                return {"ok": False, "error": "insufficient_coins", "price": price}

            ts = now_ms()
            conn.execute(
                "UPDATE players SET coins = coins - ?, skin = ?, updated_ms = ? WHERE id = ?",
                (price, skin_id, ts, player_id),
            )
            conn.execute(
                "INSERT OR IGNORE INTO skins(player_id, skin_id, created_ms) VALUES(?,?,?)",
                (player_id, skin_id, ts),
            )
            new_balance = balance - price

        return {"ok": True, "skinId": skin_id, "coins": new_balance,
                "spent": price, "equipped": True}

    def consume_upgrade(self, player_id: int, item_id: str, count: int = 1) -> int:
        """
        Spend ``count`` units of a consumable (e.g. a hoverboard).

        Returns the remaining stock; never drops below zero.
        """
        with self.tx() as conn:
            row = conn.execute(
                "SELECT level FROM upgrades WHERE player_id = ? AND item_id = ?",
                (player_id, item_id),
            ).fetchone()
            have = int(row["level"]) if row else 0
            left = max(0, have - max(0, int(count)))
            if row:
                conn.execute(
                    "UPDATE upgrades SET level = ?, updated_ms = ? "
                    "WHERE player_id = ? AND item_id = ?",
                    (left, now_ms(), player_id, item_id),
                )
        return left

    # ======================================================================
    # Run sessions
    # ======================================================================

    def start_run(self, player_id: int, seed: int) -> str:
        """Issue a single-use run token and record its start time."""
        token = secrets.token_urlsafe(18)
        with self.tx() as conn:
            conn.execute(
                "INSERT INTO runs(token, player_id, started_ms, seed) VALUES(?,?,?,?)",
                (token, player_id, now_ms(), int(seed)),
            )
        return token

    def take_run(self, token: str, player_id: int) -> Optional[Any]:
        """
        Atomically redeem a run token.

        Returns the row if the token exists, belongs to ``player_id``, and has
        not been redeemed before; otherwise ``None``.
        """
        with self.tx() as conn:
            row = conn.execute(
                "SELECT * FROM runs WHERE token = ? AND player_id = ?", (token, player_id)
            ).fetchone()
            if row is None or row["used_ms"] is not None:
                return None
            conn.execute("UPDATE runs SET used_ms = ? WHERE token = ?", (now_ms(), token))
            return row

    def prune_runs(self) -> int:
        """Delete stale run tokens. Returns the number removed."""
        cutoff = now_ms() - config.RUN_TOKEN_PRUNE_SEC * 1000
        with self.tx() as conn:
            cur = conn.execute("DELETE FROM runs WHERE started_ms < ?", (cutoff,))
        return cur.rowcount or 0

    # ======================================================================
    # Scores & leaderboard
    # ======================================================================

    def record_score(
        self,
        player_id: int,
        *,
        score: int,
        coins: int,
        distance: float,
        duration_ms: int,
        best_combo: int,
        coins_banked: int,
    ) -> dict:
        """
        Append a run result and roll the player's aggregate stats forward.

        Returns a summary including whether this run set a personal best and
        the player's new coin balance.
        """
        ts = now_ms()
        with self.tx() as conn:
            prow = conn.execute("SELECT * FROM players WHERE id = ?", (player_id,)).fetchone()
            if prow is None:
                return {"ok": False, "error": "no_player"}

            name = prow["name"]
            score_id = conn.insert_id(
                """
                INSERT INTO scores
                    (player_id, name, score, coins, distance, duration_ms,
                     best_combo, created_ms)
                VALUES (?,?,?,?,?,?,?,?)
                """,
                (player_id, name, int(score), int(coins), float(distance),
                 int(duration_ms), int(best_combo), ts),
            )

            is_best = int(score) > int(prow["best_score"])
            # GREATEST rather than MAX: in PostgreSQL MAX() is strictly an
            # aggregate and the two-argument scalar form is a syntax error.
            # SQLite has no GREATEST, so the driver rewrites it back to MAX().
            conn.execute(
                """
                UPDATE players
                   SET best_score  = GREATEST(best_score, ?),
                       best_distance = GREATEST(best_distance, ?),
                       runs        = runs + 1,
                       play_ms     = play_ms + ?,
                       coins       = coins + ?,
                       total_coins = total_coins + ?,
                       updated_ms  = ?
                 WHERE id = ?
                """,
                (int(score), float(distance), int(duration_ms),
                 int(coins_banked), int(coins_banked), ts, player_id),
            )
            after = conn.execute("SELECT * FROM players WHERE id = ?", (player_id,)).fetchone()

        return {
            "ok": True,
            "scoreId": score_id,
            "personalBest": is_best,
            "coins": int(after["coins"]),
            "bestScore": int(after["best_score"]),
            "runs": int(after["runs"]),
            "coinsBanked": int(coins_banked),
        }

    def leaderboard(self, limit: int = 20, *, since_ms: Optional[int] = None,
                    best_per_player: bool = True) -> list[dict]:
        """
        Top runs, optionally limited to a time window.

        With ``best_per_player`` (the default) each player appears once with
        their single best run, which reads better than one person filling the
        whole board.
        """
        limit = max(1, min(int(limit), 100))
        params: list[Any] = []
        where = ""
        if since_ms is not None:
            where = "WHERE created_ms >= ?"
            params.append(int(since_ms))

        if best_per_player:
            # One row per player: the player's single best run, with every
            # column taken from that same row.
            #
            # The obvious GROUP BY formulation is wrong here. MAX(score) and
            # MAX(distance) are independent aggregates, so they can be sourced
            # from two different runs - a player whose best score came from a
            # short run would be shown with the distance of some other, longer
            # run. MIN(created_ms) has the same problem and additionally breaks
            # the created_ms tie-break, since it reports the player's earliest
            # run rather than the time of the run being ranked.
            #
            # ROW_NUMBER() picks one real row and keeps it intact. Supported by
            # PostgreSQL and by SQLite 3.25+ (2018), comfortably below the
            # version bundled with any supported Python.
            #
            # Partitioning on player_id alone - not (player_id, name) - means a
            # rename that failed to propagate to historical score rows still
            # collapses to a single leaderboard entry.
            sql = f"""
                SELECT player_id, name, score, distance, created_ms
                  FROM (
                        SELECT s.player_id, s.name, s.score, s.distance,
                               s.created_ms,
                               ROW_NUMBER() OVER (
                                   PARTITION BY s.player_id
                                   ORDER BY s.score DESC, s.created_ms ASC
                               ) AS rn
                          FROM scores s
                          {where}
                       ) ranked
                 WHERE rn = 1
                 ORDER BY score DESC, created_ms ASC
                 LIMIT ?
            """
        else:
            sql = f"""
                SELECT s.player_id, s.name, s.score, s.distance, s.created_ms
                  FROM scores s
                  {where}
                 ORDER BY s.score DESC, s.created_ms ASC
                 LIMIT ?
            """
        params.append(limit)
        rows = self.query(sql, params)
        return [
            {
                "rank": i + 1,
                "name": r["name"],
                "score": int(r["score"]),
                "distance": float(r["distance"]),
                "playerId": r["player_id"],
                "createdMs": int(r["created_ms"]),
            }
            for i, r in enumerate(rows)
        ]

    def player_rank(self, player_id: int) -> Optional[int]:
        """1-based rank of a player's best score on the all-time board."""
        row = self.query_one("SELECT best_score FROM players WHERE id = ?", (player_id,))
        if row is None or not row["best_score"]:
            return None
        best = int(row["best_score"])
        ahead = self.query_one(
            "SELECT COUNT(*) AS c FROM players WHERE best_score > ?", (best,)
        )
        return int(ahead["c"]) + 1 if ahead else None

    def recent_scores(self, player_id: int, limit: int = 10) -> list[dict]:
        """A player's most recent runs, newest first."""
        rows = self.query(
            """
            SELECT score, coins, distance, duration_ms, best_combo, created_ms
              FROM scores WHERE player_id = ?
             ORDER BY created_ms DESC LIMIT ?
            """,
            (player_id, max(1, min(int(limit), 50))),
        )
        return [
            {
                "score": int(r["score"]),
                "coins": int(r["coins"]),
                "distance": float(r["distance"]),
                "durationMs": int(r["duration_ms"]),
                "bestCombo": int(r["best_combo"]),
                "createdMs": int(r["created_ms"]),
            }
            for r in rows
        ]

    def stats(self) -> dict:
        """Global counters for the info panel."""
        row = self.query_one(
            "SELECT COUNT(*) AS runs, COALESCE(SUM(distance),0) AS dist,"
            " COALESCE(SUM(coins),0) AS coins FROM scores"
        )
        players = self.query_one("SELECT COUNT(*) AS c FROM players")
        return {
            "totalRuns": int(row["runs"]) if row else 0,
            "totalDistance": float(row["dist"]) if row else 0.0,
            "totalCoins": int(row["coins"]) if row else 0,
            "players": int(players["c"]) if players else 0,
        }
