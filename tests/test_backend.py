"""
Backend test suite (stdlib unittest, no dependencies).

    python -m unittest discover -s tests -v
"""

from __future__ import annotations

import re
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.app import config
from server.app.api import Api, Request, clean_name
from server.app.db import Database, NameTakenError, _BIGINT_COLUMNS, now_ms
from server.app.driver import strip_pragmas, to_postgres
from server.app.validation import RunClaim, validate_run


def call(api, method, path, body=None, token=None, query=None):
    headers = {"authorization": f"Bearer {token}"} if token else {}
    response = api.dispatch(
        Request(method, path, query or {}, body or {}, headers, "127.0.0.1")
    )
    return response.status, response.data


class ValidationTests(unittest.TestCase):
    def test_accepts_plausible_run(self):
        claim = RunClaim.from_payload(
            {"score": 5000, "coins": 120, "distance": 900, "durationMs": 40_000}
        )
        verdict = validate_run(claim)
        self.assertTrue(verdict.accepted, verdict.reasons)
        self.assertGreater(verdict.coins_banked, 0)

    def test_rejects_impossible_distance(self):
        claim = RunClaim.from_payload(
            {"score": 100, "coins": 0, "distance": 50_000, "durationMs": 5_000}
        )
        verdict = validate_run(claim)
        self.assertFalse(verdict.accepted)
        self.assertIn("distance_impossible", verdict.reasons)

    def test_clamps_score_to_ceiling(self):
        claim = RunClaim.from_payload(
            {"score": 10**9, "coins": 10, "distance": 100, "durationMs": 20_000}
        )
        verdict = validate_run(claim)
        self.assertFalse(verdict.accepted)
        self.assertLess(verdict.score, 10**9)

    def test_duration_cannot_exceed_session(self):
        claim = RunClaim.from_payload(
            {"score": 10, "coins": 0, "distance": 10, "durationMs": 600_000}
        )
        now = int(time.time() * 1000)
        verdict = validate_run(
            claim, server_started_ms=now - 2000, server_now_ms=now
        )
        self.assertIn("duration_exceeds_session", verdict.reasons)

    def test_rejects_non_numeric(self):
        with self.assertRaises(ValueError):
            RunClaim.from_payload({"score": "lots", "distance": 1, "durationMs": 1})

    def test_rejects_missing_field(self):
        with self.assertRaises(ValueError):
            RunClaim.from_payload({"coins": 1})


class NameTests(unittest.TestCase):
    def test_strips_control_characters(self):
        self.assertEqual(clean_name("ab\x00\x1fcd"), "abcd")

    def test_falls_back_when_empty(self):
        self.assertEqual(clean_name("   "), config.DEFAULT_NAME)
        self.assertEqual(clean_name(None), config.DEFAULT_NAME)

    def test_truncates(self):
        self.assertLessEqual(len(clean_name("X" * 100)), config.NAME_MAX_LEN)


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.db = Database(":memory:")
        self.api = Api(self.db)
        _, data = call(self.api, "POST", "/api/register", {"name": "TESTER"})
        self.token = data["token"]

    def tearDown(self):
        self.db.close()

    def test_health_and_config(self):
        self.assertEqual(call(self.api, "GET", "/api/health")[0], 200)
        status, data = call(self.api, "GET", "/api/config")
        self.assertEqual(status, 200)
        self.assertTrue(len(data["shop"]) > 0)

    def test_requires_auth(self):
        self.assertEqual(call(self.api, "GET", "/api/me")[0], 401)

    def test_unknown_route_and_method(self):
        self.assertEqual(call(self.api, "GET", "/api/nope")[0], 404)
        self.assertEqual(call(self.api, "POST", "/api/health")[0], 405)

    def test_full_run_flow_banks_coins(self):
        _, run = call(self.api, "POST", "/api/run/start", {}, self.token)
        time.sleep(1.05)
        _, data = call(self.api, "POST", "/api/run/submit", {
            "runToken": run["runToken"], "score": 1200, "coins": 40,
            "distance": 60, "durationMs": 1000, "bestCombo": 5,
        }, self.token)
        self.assertTrue(data["accepted"], data["reasons"])
        self.assertGreater(data["player"]["coins"], 0)
        self.assertTrue(data["personalBest"])

    def test_run_token_is_single_use(self):
        _, run = call(self.api, "POST", "/api/run/start", {}, self.token)
        time.sleep(1.05)
        payload = {
            "runToken": run["runToken"], "score": 100, "coins": 1,
            "distance": 20, "durationMs": 1000,
        }
        first = call(self.api, "POST", "/api/run/submit", dict(payload), self.token)[1]
        second = call(self.api, "POST", "/api/run/submit", dict(payload), self.token)[1]
        self.assertTrue(first["accepted"])
        self.assertFalse(second["accepted"])
        self.assertIn("invalid_run_token", second["reasons"])

    def test_purchase_requires_funds_then_succeeds(self):
        _, denied = call(self.api, "POST", "/api/shop/buy",
                         {"itemId": "hoverboard"}, self.token)
        self.assertFalse(denied["ok"])
        self.assertEqual(denied["error"], "insufficient_coins")

        self.db.add_coins(1, 5000)
        _, bought = call(self.api, "POST", "/api/shop/buy",
                         {"itemId": "hoverboard"}, self.token)
        self.assertTrue(bought["ok"])
        self.assertEqual(bought["level"], 1)

    def test_purchase_rejects_unknown_item(self):
        self.db.add_coins(1, 5000)
        _, data = call(self.api, "POST", "/api/shop/buy",
                       {"itemId": "free_money"}, self.token)
        self.assertFalse(data["ok"])

    def test_upgrade_respects_max_level(self):
        self.db.add_coins(1, 10_000_000)
        item = config.shop_index()["magnet_duration"]
        for _ in range(item["levels"]):
            call(self.api, "POST", "/api/shop/buy",
                 {"itemId": "magnet_duration"}, self.token)
        _, data = call(self.api, "POST", "/api/shop/buy",
                       {"itemId": "magnet_duration"}, self.token)
        self.assertEqual(data["error"], "max_level")

    def test_skin_purchase_and_equip(self):
        self.db.add_coins(1, 5000)
        _, data = call(self.api, "POST", "/api/shop/skin",
                       {"skinId": "gold"}, self.token)
        self.assertTrue(data["ok"])
        self.assertEqual(data["player"]["skin"], "gold")

    def test_cannot_equip_unowned_skin(self):
        self.assertEqual(
            call(self.api, "POST", "/api/me/skin", {"skinId": "void"}, self.token)[0],
            400,
        )

    def test_leaderboard_orders_by_score(self):
        for score in (500, 9000, 3000):
            _, run = call(self.api, "POST", "/api/run/start", {}, self.token)
            time.sleep(1.05)
            call(self.api, "POST", "/api/run/submit", {
                "runToken": run["runToken"], "score": score, "coins": 5,
                "distance": 50, "durationMs": 1000,
            }, self.token)
        entries = call(self.api, "GET", "/api/leaderboard")[1]["entries"]
        self.assertEqual(entries[0]["score"], 9000)

    def test_progress_roundtrip(self):
        call(self.api, "POST", "/api/me/progress",
             {"progress": {"level": 4}}, self.token)
        _, me = call(self.api, "GET", "/api/me", token=self.token)
        self.assertEqual(me["player"]["progress"]["level"], 4)

    def test_rename_updates_leaderboard(self):
        _, run = call(self.api, "POST", "/api/run/start", {}, self.token)
        time.sleep(1.05)
        call(self.api, "POST", "/api/run/submit", {
            "runToken": run["runToken"], "score": 700, "coins": 1,
            "distance": 30, "durationMs": 1000,
        }, self.token)
        call(self.api, "POST", "/api/me/name", {"name": "NEWNAME"}, self.token)
        entries = call(self.api, "GET", "/api/leaderboard")[1]["entries"]
        self.assertEqual(entries[0]["name"], "NEWNAME")


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.db = Database(":memory:")

    def tearDown(self):
        self.db.close()

    def test_tokens_are_unique_per_player(self):
        _, t1 = self.db.create_player("A")
        _, t2 = self.db.create_player("B")
        self.assertNotEqual(t1, t2)
        self.assertEqual(self.db.player_by_token(t1)["name"], "A")

    def test_bad_token_returns_none(self):
        self.assertIsNone(self.db.player_by_token("nope"))

    def test_consume_never_goes_negative(self):
        player, _ = self.db.create_player("C")
        self.assertEqual(self.db.consume_upgrade(player["id"], "hoverboard", 5), 0)


class UniqueNameTests(unittest.TestCase):
    """
    Names are claimed first-come-first-served and must be unique, since the
    leaderboard identifies players by name alone. There is no password: the
    bearer token proves ownership, uniqueness only prevents impersonation.
    """

    def setUp(self):
        self.db = Database(":memory:")
        self.api = Api(self.db)

    def tearDown(self):
        self.db.close()

    def test_second_claim_of_same_name_is_refused(self):
        status, first = call(self.api, "POST", "/api/register", {"name": "ACE"})
        self.assertEqual(status, 200)
        self.assertIn("token", first)

        status, second = call(self.api, "POST", "/api/register", {"name": "ACE"})
        self.assertEqual(status, 200)
        self.assertFalse(second["ok"])
        self.assertEqual(second["error"], "name_taken")
        self.assertNotIn("token", second)

    def test_uniqueness_is_case_insensitive(self):
        call(self.api, "POST", "/api/register", {"name": "ACE"})
        _, clash = call(self.api, "POST", "/api/register", {"name": "ace"})
        self.assertEqual(clash["error"], "name_taken")

    def test_availability_probe(self):
        _, free = call(self.api, "GET", "/api/name-available", query={"name": ["GHOST"]})
        self.assertTrue(free["available"])
        call(self.api, "POST", "/api/register", {"name": "GHOST"})
        _, taken = call(self.api, "GET", "/api/name-available", query={"name": ["GHOST"]})
        self.assertFalse(taken["available"])

    def test_rename_onto_taken_name_is_refused(self):
        call(self.api, "POST", "/api/register", {"name": "ALPHA"})
        _, mine = call(self.api, "POST", "/api/register", {"name": "BETA"})
        token = mine["token"]

        _, refused = call(self.api, "POST", "/api/me/name", {"name": "ALPHA"}, token)
        self.assertFalse(refused["ok"])
        self.assertEqual(refused["error"], "name_taken")
        # The original name must survive a refused rename.
        _, me = call(self.api, "GET", "/api/me", token=token)
        self.assertEqual(me["player"]["name"], "BETA")

    def test_rename_to_own_name_is_allowed(self):
        _, mine = call(self.api, "POST", "/api/register", {"name": "SOLO"})
        _, again = call(self.api, "POST", "/api/me/name", {"name": "SOLO"}, mine["token"])
        self.assertNotIn("error", again)

    def test_db_raises_on_duplicate(self):
        self.db.create_player("DUPE")
        with self.assertRaises(NameTakenError):
            self.db.create_player("DUPE")


class NameMigrationTests(unittest.TestCase):
    """
    Databases created before names were unique contain many players sharing the
    default name. The migration must resolve those before it can build the
    unique index, or the server would fail to start.
    """

    def test_existing_duplicates_are_deduped(self):
        db = Database(":memory:")
        try:
            # Simulate a pre-migration database: drop the index, then insert
            # colliding names directly.
            with db.tx() as conn:
                conn.execute("DROP INDEX IF EXISTS idx_players_name_unique")
                ts = 1
                for i in range(3):
                    conn.execute(
                        "INSERT INTO players (public_id, token_hash, name, "
                        "created_ms, updated_ms) VALUES (?,?,?,?,?)",
                        (f"pub{i}", f"hash{i}", "RUNNER", ts + i, ts + i),
                    )

            db._migrate_unique_names()

            names = [r["name"] for r in db.query("SELECT name FROM players ORDER BY id")]
            self.assertEqual(len(names), len(set(n.lower() for n in names)))
            # Oldest keeps the bare name.
            self.assertEqual(names[0], "RUNNER")
            # And the index now exists, so further duplicates are impossible.
            with self.assertRaises(NameTakenError):
                db.create_player("RUNNER")
        finally:
            db.close()

    def test_migration_is_idempotent(self):
        db = Database(":memory:")
        try:
            db._migrate_unique_names()
            db._migrate_unique_names()
            db.create_player("ONLY")
            self.assertTrue(db.name_taken("only"))
        finally:
            db.close()


class LeaderboardSizeTests(unittest.TestCase):
    def test_returns_up_to_one_hundred(self):
        db = Database(":memory:")
        api = Api(db)
        try:
            for i in range(105):
                player, _ = db.create_player(f"P{i:03d}")
                db.record_score(
                    player["id"], score=i, coins=0, distance=10,
                    duration_ms=1000, best_combo=0, coins_banked=0,
                )
            # Query values arrive as lists, matching urllib's parse_qs.
            _, data = call(api, "GET", "/api/leaderboard", query={"limit": ["100"]})
            self.assertEqual(len(data["entries"]), 100)
            # Highest score first.
            self.assertEqual(data["entries"][0]["score"], 104)
            # And the cap holds even if a client asks for more.
            _, big = call(api, "GET", "/api/leaderboard", query={"limit": ["5000"]})
            self.assertLessEqual(len(big["entries"]), 100)
        finally:
            db.close()


class PostgresDialectTests(unittest.TestCase):
    """
    Guards the SQLite -> PostgreSQL translation.

    These are pure string/schema assertions rather than live queries: CI has no
    PostgreSQL server, and the bug being guarded against is entirely a matter of
    which type name the schema emits.
    """

    def _pg_schema(self):
        raw = (
            Path(__file__).resolve().parents[1]
            / "server" / "app" / "schema.sql"
        ).read_text(encoding="utf-8")
        return to_postgres(strip_pragmas(raw))

    def test_no_bare_integer_columns(self):
        """
        Epoch-millisecond values overflow PostgreSQL's 4-byte INTEGER.

        now_ms() is ~1.8e12 against an int4 ceiling of 2_147_483_647, so any
        column declared INTEGER makes CREATE TABLE succeed and every INSERT
        fail with "integer out of range" - the 500 on /api/claim-name. SQLite
        stores all integers as 64-bit, so only PostgreSQL is affected.
        """
        self.assertGreater(now_ms(), 2 ** 31 - 1)

        offenders = [
            line.strip()
            for line in self._pg_schema().splitlines()
            if re.search(r"\bINTEGER\b", line, re.I)
            and not line.strip().startswith("--")
        ]
        self.assertEqual(offenders, [], f"int4 columns in PG schema: {offenders}")

    def test_autoincrement_becomes_bigserial(self):
        """BIGSERIAL, not SERIAL, so ids match the BIGINT foreign keys."""
        pg = self._pg_schema()
        self.assertIn("BIGSERIAL PRIMARY KEY", pg)
        self.assertNotIn("AUTOINCREMENT", pg)
        self.assertFalse(re.search(r"(?<!BIG)SERIAL PRIMARY KEY", pg))

    def test_migration_list_matches_schema(self):
        """
        Every BIGINT column in schema.sql must be in _BIGINT_COLUMNS.

        schema.sql only governs databases being created for the first time;
        CREATE TABLE IF NOT EXISTS leaves an existing deployment untouched. The
        migration list is what repairs those, so the two must not drift apart.
        """
        raw = (
            Path(__file__).resolve().parents[1]
            / "server" / "app" / "schema.sql"
        ).read_text(encoding="utf-8")

        declared, table = set(), None
        for line in raw.splitlines():
            created = re.match(r"\s*CREATE TABLE IF NOT EXISTS (\w+)", line)
            if created:
                table = created.group(1)
                continue
            column = re.match(r"\s*(\w+)\s+BIGINT\b", line, re.I)
            if column and table:
                declared.add((table, column.group(1)))

        self.assertTrue(declared, "schema.sql declared no BIGINT columns")
        self.assertEqual(declared, set(_BIGINT_COLUMNS))

    def test_widen_migration_is_noop_on_sqlite(self):
        """SQLite integers are already 64-bit; the migration must skip it."""
        db = Database(":memory:")
        try:
            self.assertFalse(db.postgres)
            db._migrate_widen_integers()  # must not raise
            player, _ = db.create_player("BIGTS")
            self.assertGreater(player["createdMs"], 2 ** 31 - 1)
        finally:
            db.close()


class LeaderboardShapeTests(unittest.TestCase):
    def test_one_row_per_player_from_a_single_run(self):
        """
        Each player appears once, showing their best run intact.

        MAX(score) and MAX(distance) are independent aggregates, so the old
        GROUP BY could pair a player's best score with the distance of an
        entirely different run. ALICE's best score comes from her *shortest*
        run, which makes that mismatch observable.
        """
        db = Database(":memory:")
        try:
            alice, _ = db.create_player("ALICE")
            bob, _ = db.create_player("BOB")

            for score, distance in ((500, 9000.0), (2000, 300.0), (700, 1200.0)):
                db.record_score(
                    alice["id"], score=score, coins=0, distance=distance,
                    duration_ms=30000, best_combo=0, coins_banked=0,
                )
            db.record_score(
                bob["id"], score=1500, coins=0, distance=600.0,
                duration_ms=30000, best_combo=0, coins_banked=0,
            )

            board = db.leaderboard(limit=50)
            self.assertEqual([e["name"] for e in board], ["ALICE", "BOB"])
            self.assertEqual([e["score"] for e in board], [2000, 1500])
            # The distance must come from the same row as the score.
            self.assertEqual(board[0]["distance"], 300.0)

        finally:
            db.close()

    def test_rename_does_not_split_a_player(self):
        """Grouping is by player_id, so stale score-row names cannot split."""
        db = Database(":memory:")
        try:
            player, _ = db.create_player("OLDNAME")
            db.record_score(
                player["id"], score=100, coins=0, distance=10.0,
                duration_ms=5000, best_combo=0, coins_banked=0,
            )
            db.rename_player(player["id"], "NEWNAME")
            db.record_score(
                player["id"], score=900, coins=0, distance=20.0,
                duration_ms=5000, best_combo=0, coins_banked=0,
            )

            board = db.leaderboard(limit=50)
            self.assertEqual(len(board), 1)
            self.assertEqual(board[0]["score"], 900)
        finally:
            db.close()

    def test_runs_mode_still_lists_every_run(self):
        """mode=runs is unchanged: one row per run, not per player."""
        db = Database(":memory:")
        try:
            player, _ = db.create_player("MULTI")
            for score in (10, 20, 30):
                db.record_score(
                    player["id"], score=score, coins=0, distance=5.0,
                    duration_ms=5000, best_combo=0, coins_banked=0,
                )
            self.assertEqual(len(db.leaderboard(50, best_per_player=False)), 3)
            self.assertEqual(len(db.leaderboard(50, best_per_player=True)), 1)
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
