"""
Run-result validation ("plausibility envelope").

A browser game can never fully trust its client, but it *can* refuse results
that are physically impossible for the game to produce. Every submitted run is
checked against the same physics ceilings the client is built from
(:data:`config.PHYSICS`), plus the server's own record of when the run started.

The philosophy is deliberately forgiving: we reject the obviously fabricated
(a 10-second run claiming 40 km) while never punishing a laggy phone. Rejected
runs still return HTTP 200 with ``accepted: False`` so the client can show the
score locally without pretending it made the leaderboard.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from . import config


@dataclass
class RunClaim:
    """Normalised, type-safe view of a client's submitted run."""

    score: int
    coins: int
    distance: float
    duration_ms: int
    best_combo: int = 0

    @classmethod
    def from_payload(cls, data: dict) -> "RunClaim":
        """
        Build a claim from raw JSON, coercing types and clamping to sane rails.

        Raises :class:`ValueError` if a required field is missing or not
        numeric, which the API layer turns into a 400.
        """
        def num(key: str, default: Optional[float] = None) -> float:
            if key not in data or data[key] is None:
                if default is None:
                    raise ValueError(f"missing field: {key}")
                return float(default)
            value = data[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"field {key} must be a number")
            if value != value or value in (float("inf"), float("-inf")):  # NaN / inf
                raise ValueError(f"field {key} is not finite")
            return float(value)

        phys = config.PHYSICS
        return cls(
            score=int(max(0.0, min(num("score"), 1e12))),
            coins=int(max(0.0, min(num("coins", 0), 1e9))),
            distance=max(0.0, min(num("distance"), phys["max_distance_m"])),
            duration_ms=int(max(0.0, min(num("durationMs"), phys["max_duration_ms"]))),
            best_combo=int(max(0.0, min(num("bestCombo", 0), 1e6))),
        )


@dataclass
class Verdict:
    """Outcome of validation."""

    accepted: bool
    reasons: list[str] = field(default_factory=list)
    #: Values the server is willing to accept (clamped where necessary).
    score: int = 0
    coins: int = 0
    distance: float = 0.0
    duration_ms: int = 0
    best_combo: int = 0
    coins_banked: int = 0

    def as_dict(self) -> dict:
        return {
            "accepted": self.accepted,
            "reasons": self.reasons,
            "score": self.score,
            "coins": self.coins,
            "distance": self.distance,
        }


def _max_distance_for(duration_ms: int) -> float:
    """Furthest a legitimate client could travel in ``duration_ms``."""
    phys = config.PHYSICS
    seconds = duration_ms / 1000.0
    # A flat allowance covers the head-start upgrade and start-line offset.
    return phys["max_speed_mps"] * phys["speed_tolerance"] * seconds + 400.0


def _max_coins_for(distance: float) -> int:
    phys = config.PHYSICS
    return int(distance * phys["max_coins_per_metre"] + phys["coins_flat_allowance"])


def _max_score_for(distance: float, coins: int) -> int:
    phys = config.PHYSICS
    ceiling = (
        distance * phys["score_per_metre"] + coins * phys["score_per_coin"]
    ) * phys["max_multiplier_stack"]
    return int(ceiling + phys["score_flat_allowance"])


def validate_run(
    claim: RunClaim,
    *,
    server_started_ms: Optional[int] = None,
    server_now_ms: Optional[int] = None,
) -> Verdict:
    """
    Check ``claim`` against the plausibility envelope.

    ``server_started_ms`` / ``server_now_ms`` come from the redeemed run token.
    When supplied, the client's self-reported duration is cross-checked against
    real elapsed wall-clock time, which is the strongest signal available: you
    cannot claim a 20-minute run from a token issued 5 seconds ago.
    """
    phys = config.PHYSICS
    reasons: list[str] = []

    duration_ms = claim.duration_ms
    distance = claim.distance
    coins = claim.coins
    score = claim.score

    # 1. Wall-clock sanity: the reported duration cannot exceed the real time
    #    the token has been alive (plus slack for network + clock skew).
    if server_started_ms is not None and server_now_ms is not None:
        elapsed = max(0, server_now_ms - server_started_ms)
        allowed = elapsed + 15_000
        if duration_ms > allowed:
            reasons.append("duration_exceeds_session")
        # Judge distance/score against the largest duration that is actually
        # defensible, rather than zeroing the run outright.
        duration_ms = min(duration_ms, allowed)

    # 2. Absurdly short runs are treated as noise, not cheating.
    if duration_ms < phys["min_duration_ms"]:
        return Verdict(
            accepted=False,
            reasons=["run_too_short"],
            score=score, coins=coins, distance=distance,
            duration_ms=duration_ms, best_combo=claim.best_combo,
            coins_banked=0,
        )

    # 3. Distance must be reachable at max speed for the elapsed time.
    dist_cap = _max_distance_for(duration_ms)
    if distance > dist_cap:
        reasons.append("distance_impossible")
        distance = dist_cap

    # 4. Coins are bounded by how many can physically be spawned per metre.
    coin_cap = _max_coins_for(distance)
    if coins > coin_cap:
        reasons.append("coins_impossible")
        coins = coin_cap

    # 5. Score is bounded by the best-case multiplier stack over the above.
    score_cap = _max_score_for(distance, coins)
    if score > score_cap:
        reasons.append("score_impossible")
        score = score_cap

    banked = int(coins * config.COIN_BANK_RATE)
    banked += int((distance / 1000.0) * config.COIN_DISTANCE_BONUS_PER_KM)

    return Verdict(
        accepted=not reasons,
        reasons=reasons,
        score=int(score),
        coins=int(coins),
        distance=float(distance),
        duration_ms=int(duration_ms),
        best_combo=int(claim.best_combo),
        coins_banked=banked,
    )
