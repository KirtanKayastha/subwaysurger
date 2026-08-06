"""
JSON API surface.

A tiny hand-rolled router sits between :mod:`http.server` and the database.
Handlers are plain functions taking a :class:`Request` and returning a
:class:`Response`, which keeps them trivially unit-testable without spinning up
a socket.

Auth model
----------
On first launch the client calls ``POST /api/register`` and stores the returned
bearer token in ``localStorage``. Every subsequent mutating call carries it via
``Authorization: Bearer <token>``. There are no passwords: the token *is* the
identity. That is the right trade-off for an arcade leaderboard, and it means
the game works instantly with zero sign-up friction.
"""

from __future__ import annotations

import json
import random
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

from . import config
from .db import Database, now_ms
from .validation import RunClaim, validate_run


# --------------------------------------------------------------------------
# Request / response plumbing
# --------------------------------------------------------------------------

@dataclass
class Request:
    method: str
    path: str
    query: dict[str, list[str]]
    body: dict
    headers: dict[str, str]
    client_ip: str = "0.0.0.0"
    #: Path parameters captured by the route pattern.
    params: dict[str, str] = field(default_factory=dict)

    def bearer(self) -> str:
        """Extract the bearer token, tolerating header-case differences."""
        raw = self.headers.get("authorization") or self.headers.get("Authorization") or ""
        if raw.lower().startswith("bearer "):
            return raw[7:].strip()
        return ""

    def q(self, key: str, default: str = "") -> str:
        values = self.query.get(key)
        return values[0] if values else default

    def q_int(self, key: str, default: int) -> int:
        try:
            return int(self.q(key, str(default)))
        except (TypeError, ValueError):
            return default


@dataclass
class Response:
    status: int = 200
    data: object = None
    headers: dict[str, str] = field(default_factory=dict)

    def to_bytes(self) -> bytes:
        return json.dumps(self.data, separators=(",", ":")).encode("utf-8")


def ok(data: object = None, **extra) -> Response:
    payload = {"ok": True}
    if isinstance(data, dict):
        payload.update(data)
    elif data is not None:
        payload["data"] = data
    payload.update(extra)
    return Response(200, payload)


def err(status: int, code: str, message: str = "") -> Response:
    return Response(status, {"ok": False, "error": code, "message": message or code})


# --------------------------------------------------------------------------
# Rate limiting
# --------------------------------------------------------------------------

class RateLimiter:
    """
    Per-IP token bucket.

    Cheap protection against a stuck client hammering the score endpoint. Not a
    security boundary, just good manners for a local server.
    """

    def __init__(self, burst: int = config.RATE_LIMIT_BURST,
                 rate: float = config.RATE_LIMIT_PER_SEC) -> None:
        self.burst = float(burst)
        self.rate = float(rate)
        self._buckets: dict[str, tuple[float, float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str, cost: float = 1.0) -> bool:
        now = time.monotonic()
        with self._lock:
            tokens, last = self._buckets.get(key, (self.burst, now))
            tokens = min(self.burst, tokens + (now - last) * self.rate)
            if tokens < cost:
                self._buckets[key] = (tokens, now)
                return False
            self._buckets[key] = (tokens - cost, now)
            return True


# --------------------------------------------------------------------------
# Validation helpers
# --------------------------------------------------------------------------

_NAME_STRIP = re.compile(r"[\x00-\x1f\x7f]")


def clean_name(raw: object) -> str:
    """
    Sanitise a display name: strip control characters, collapse whitespace and
    clamp the length. Falls back to the default name when nothing survives.
    """
    if not isinstance(raw, str):
        return config.DEFAULT_NAME
    name = _NAME_STRIP.sub("", raw)
    name = " ".join(name.split())
    name = name[: config.NAME_MAX_LEN].strip()
    if len(name) < config.NAME_MIN_LEN:
        return config.DEFAULT_NAME
    return name


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------

Handler = Callable[[Request], Response]


class Api:
    """Routing table plus handler implementations."""

    def __init__(self, db: Database) -> None:
        self.db = db
        self.limiter = RateLimiter()
        self.routes: list[tuple[str, re.Pattern[str], Handler, bool]] = []
        self._register_routes()

    # -- routing ------------------------------------------------------------

    def add(self, method: str, pattern: str, handler: Handler, *, auth: bool = False) -> None:
        """
        Register a route. ``pattern`` may contain ``{name}`` placeholders.

        ``auth=True`` requires a valid bearer token; the resolved player is
        attached to ``request.params['_player']``.
        """
        regex = re.compile("^" + re.sub(r"\{(\w+)\}", r"(?P<\1>[^/]+)", pattern) + "$")
        self.routes.append((method.upper(), regex, handler, auth))

    def _register_routes(self) -> None:
        self.add("GET",  "/api/health", self.health)
        self.add("GET",  "/api/config", self.get_config)
        self.add("GET",  "/api/leaderboard", self.get_leaderboard)
        self.add("GET",  "/api/stats", self.get_stats)
        self.add("POST", "/api/register", self.register)
        self.add("GET",  "/api/me", self.get_me, auth=True)
        self.add("POST", "/api/me/name", self.set_name, auth=True)
        self.add("POST", "/api/me/progress", self.set_progress, auth=True)
        self.add("POST", "/api/me/skin", self.equip_skin, auth=True)
        self.add("GET",  "/api/me/scores", self.my_scores, auth=True)
        self.add("POST", "/api/run/start", self.run_start, auth=True)
        self.add("POST", "/api/run/submit", self.run_submit, auth=True)
        self.add("POST", "/api/shop/buy", self.shop_buy, auth=True)
        self.add("POST", "/api/shop/skin", self.shop_buy_skin, auth=True)
        self.add("POST", "/api/shop/consume", self.shop_consume, auth=True)

    def dispatch(self, request: Request) -> Response:
        """Resolve and invoke the handler for ``request``."""
        if not self.limiter.allow(request.client_ip):
            return err(429, "rate_limited", "Slow down a moment.")

        path_matched = False
        for method, regex, handler, auth in self.routes:
            match = regex.match(request.path)
            if not match:
                continue
            path_matched = True
            if method != request.method:
                continue
            request.params.update(match.groupdict())
            if auth:
                player = self.db.player_by_token(request.bearer())
                if player is None:
                    return err(401, "unauthorized", "Missing or invalid token.")
                request.params["_player"] = player  # type: ignore[assignment]
            try:
                return handler(request)
            except ValueError as exc:
                return err(400, "bad_request", str(exc))
            except Exception as exc:  # pragma: no cover - defensive
                return err(500, "server_error", f"{type(exc).__name__}: {exc}")

        if path_matched:
            return err(405, "method_not_allowed")
        return err(404, "not_found")

    @staticmethod
    def _player(request: Request) -> dict:
        return request.params["_player"]  # type: ignore[return-value]

    # -- public endpoints ---------------------------------------------------

    def health(self, request: Request) -> Response:
        return ok({"version": config.API_VERSION, "time": now_ms()})

    def get_config(self, request: Request) -> Response:
        """Expose the authoritative shop/skin catalogs and tuning constants."""
        return ok({
            "version": config.API_VERSION,
            "shop": config.SHOP_CATALOG,
            "skins": config.SKIN_CATALOG,
            "physics": config.PHYSICS,
        })

    def get_leaderboard(self, request: Request) -> Response:
        """
        ``GET /api/leaderboard?limit=20&window=all|day|week&mode=best|runs``
        """
        limit = request.q_int("limit", 20)
        window = request.q("window", "all")
        since = None
        if window == "day":
            since = now_ms() - 24 * 3600 * 1000
        elif window == "week":
            since = now_ms() - 7 * 24 * 3600 * 1000
        best_per_player = request.q("mode", "best") != "runs"
        board = self.db.leaderboard(limit, since_ms=since, best_per_player=best_per_player)
        return ok({"entries": board, "window": window})

    def get_stats(self, request: Request) -> Response:
        return ok({"stats": self.db.stats()})

    def register(self, request: Request) -> Response:
        """Create a player and hand back a bearer token (shown once)."""
        name = clean_name(request.body.get("name"))
        player, token = self.db.create_player(name)
        return ok({
            "token": token,
            "player": self._profile_payload(player),
        })

    # -- authenticated: profile --------------------------------------------

    def _profile_payload(self, player: dict) -> dict:
        """Assemble the full client-side view of a player."""
        pid = player["id"]
        payload = dict(player)
        payload.pop("id", None)  # internal row id stays server-side
        payload["upgrades"] = self.db.upgrades_for(pid)
        payload["ownedSkins"] = self.db.skins_for(pid)
        payload["rank"] = self.db.player_rank(pid)
        return payload

    def get_me(self, request: Request) -> Response:
        player = self._player(request)
        return ok({"player": self._profile_payload(player)})

    def set_name(self, request: Request) -> Response:
        player = self._player(request)
        name = clean_name(request.body.get("name"))
        self.db.rename_player(player["id"], name)
        fresh = self.db.player_by_id(player["id"])
        return ok({"player": self._profile_payload(fresh)})

    def set_progress(self, request: Request) -> Response:
        """Store the opaque client progress blob (missions, seen-tutorial...)."""
        player = self._player(request)
        blob = request.body.get("progress")
        if not isinstance(blob, dict):
            return err(400, "bad_request", "progress must be an object")
        self.db.save_progress(player["id"], blob)
        return ok({"saved": True})

    def equip_skin(self, request: Request) -> Response:
        player = self._player(request)
        skin_id = str(request.body.get("skinId", ""))
        if not self.db.set_skin(player["id"], skin_id):
            return err(400, "not_owned", "You do not own that skin.")
        fresh = self.db.player_by_id(player["id"])
        return ok({"player": self._profile_payload(fresh)})

    def my_scores(self, request: Request) -> Response:
        player = self._player(request)
        return ok({"scores": self.db.recent_scores(player["id"], request.q_int("limit", 10))})

    # -- authenticated: runs ------------------------------------------------

    def run_start(self, request: Request) -> Response:
        """
        Begin a run: returns a one-shot token and the level seed.

        The seed lets the server reproduce the exact obstacle layout a client
        played, which is useful for future replay verification.
        """
        player = self._player(request)
        seed = random.getrandbits(31)
        token = self.db.start_run(player["id"], seed)
        return ok({"runToken": token, "seed": seed, "startedMs": now_ms()})

    def run_submit(self, request: Request) -> Response:
        """
        Submit a finished run.

        Always returns 200 with an ``accepted`` flag: a rejected run is not an
        error the player should see as a crash, it just does not make the
        leaderboard. Coins are only banked for accepted runs.
        """
        player = self._player(request)
        claim = RunClaim.from_payload(request.body)

        run_token = str(request.body.get("runToken", ""))
        row = self.db.take_run(run_token, player["id"]) if run_token else None
        if row is None:
            return ok({
                "accepted": False,
                "reasons": ["invalid_run_token"],
                "player": self._profile_payload(self.db.player_by_id(player["id"])),
            })

        started = int(row["started_ms"])
        if now_ms() - started > config.RUN_TOKEN_TTL_SEC * 1000:
            return ok({
                "accepted": False,
                "reasons": ["run_token_expired"],
                "player": self._profile_payload(self.db.player_by_id(player["id"])),
            })

        verdict = validate_run(claim, server_started_ms=started, server_now_ms=now_ms())

        result: dict = {}
        if verdict.accepted:
            result = self.db.record_score(
                player["id"],
                score=verdict.score,
                coins=verdict.coins,
                distance=verdict.distance,
                duration_ms=verdict.duration_ms,
                best_combo=verdict.best_combo,
                coins_banked=verdict.coins_banked,
            )

        fresh = self.db.player_by_id(player["id"])
        return ok({
            "accepted": verdict.accepted,
            "reasons": verdict.reasons,
            "personalBest": bool(result.get("personalBest", False)),
            "coinsBanked": int(result.get("coinsBanked", 0)),
            "score": verdict.score,
            "player": self._profile_payload(fresh),
        })

    # -- authenticated: shop ------------------------------------------------

    def shop_buy(self, request: Request) -> Response:
        player = self._player(request)
        item_id = str(request.body.get("itemId", ""))
        outcome = self.db.purchase(player["id"], item_id)
        if not outcome.get("ok"):
            return Response(200, {
                "ok": False,
                "error": outcome.get("error", "purchase_failed"),
                "price": outcome.get("price"),
                "player": self._profile_payload(self.db.player_by_id(player["id"])),
            })
        fresh = self.db.player_by_id(player["id"])
        return ok({
            "itemId": outcome["itemId"],
            "level": outcome["level"],
            "spent": outcome["spent"],
            "player": self._profile_payload(fresh),
        })

    def shop_buy_skin(self, request: Request) -> Response:
        player = self._player(request)
        skin_id = str(request.body.get("skinId", ""))
        outcome = self.db.buy_skin(player["id"], skin_id)
        fresh = self.db.player_by_id(player["id"])
        if not outcome.get("ok"):
            return Response(200, {
                "ok": False,
                "error": outcome.get("error", "purchase_failed"),
                "price": outcome.get("price"),
                "player": self._profile_payload(fresh),
            })
        return ok({
            "skinId": outcome["skinId"],
            "spent": outcome["spent"],
            "player": self._profile_payload(fresh),
        })

    def shop_consume(self, request: Request) -> Response:
        """Burn a consumable (called when a hoverboard saves the player)."""
        player = self._player(request)
        item_id = str(request.body.get("itemId", ""))
        count = request.body.get("count", 1)
        try:
            count = int(count)
        except (TypeError, ValueError):
            count = 1
        left = self.db.consume_upgrade(player["id"], item_id, count)
        return ok({"itemId": item_id, "left": left})
