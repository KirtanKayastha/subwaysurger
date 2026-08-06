"""
Backend test suite (stdlib unittest, no dependencies).

    python -m unittest discover -s tests -v
"""

from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.app import config
from server.app.api import Api, Request, clean_name
from server.app.db import Database
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


if __name__ == "__main__":
    unittest.main()
