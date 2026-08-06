"""
Central configuration for the NEON RUSH backend.

Everything tunable lives here so the rest of the package stays free of magic
numbers. The PHYSICS block intentionally mirrors the client-side constants in
``web/js/engine/constants.js``; it is the ceiling used by the anti-cheat
plausibility checks, so it must stay >= whatever the client can legitimately
produce. When you change client physics, widen these caps too.
"""

from __future__ import annotations

from pathlib import Path

# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------

#: Repository root (.../subwaysurger)
ROOT_DIR = Path(__file__).resolve().parents[2]

#: Directory containing the static frontend that the server hosts.
WEB_DIR = ROOT_DIR / "web"

#: Directory holding the SQLite database (created on demand).
DATA_DIR = ROOT_DIR / "data"

#: Default database location.
DEFAULT_DB_PATH = DATA_DIR / "neonrush.sqlite3"


# --------------------------------------------------------------------------
# Server
# --------------------------------------------------------------------------

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000

#: Largest request body we will read (bytes). Payloads are tiny JSON blobs.
MAX_BODY_BYTES = 64 * 1024

#: Simple per-IP token bucket: capacity and refill rate (tokens per second).
RATE_LIMIT_BURST = 60
RATE_LIMIT_PER_SEC = 10.0

#: Current API/client contract version. Bumped when payload shapes change.
API_VERSION = "1.0.0"


# --------------------------------------------------------------------------
# Identity
# --------------------------------------------------------------------------

#: Bytes of entropy for player secret tokens.
TOKEN_BYTES = 32

#: Allowed display-name length (characters, after trimming).
NAME_MIN_LEN = 1
NAME_MAX_LEN = 16

#: Fallback name when a client sends nothing usable.
DEFAULT_NAME = "RUNNER"


# --------------------------------------------------------------------------
# Run sessions
# --------------------------------------------------------------------------

#: A run token is only redeemable for this long (seconds). Prevents a client
#: from hoarding tokens and submitting a batch of fabricated runs later.
RUN_TOKEN_TTL_SEC = 6 * 60 * 60

#: Sessions older than this are pruned from the table on startup.
RUN_TOKEN_PRUNE_SEC = 24 * 60 * 60


# --------------------------------------------------------------------------
# Physics ceilings (anti-cheat plausibility envelope)
# --------------------------------------------------------------------------

PHYSICS = {
    # Peak forward speed the client can reach, including the turbo multiplier,
    # in world metres per second.
    "max_speed_mps": 80.0,
    # Tolerance factor applied to distance/duration comparisons to absorb
    # frame-timing jitter, tab throttling and clock skew.
    "speed_tolerance": 1.25,
    # Coins are laid out at roughly one per 1.2 m in the densest patterns; the
    # magnet can sweep neighbouring lanes, so allow a generous ceiling.
    "max_coins_per_metre": 1.6,
    "coins_flat_allowance": 600,
    # Score ceiling helpers: distance and coins are each worth a base amount,
    # scaled by the maximum achievable multiplier stack.
    "score_per_metre": 2.0,
    "score_per_coin": 10.0,
    "max_multiplier_stack": 12.0,
    "score_flat_allowance": 10_000,
    # Absolute sanity rails.
    "max_duration_ms": 3 * 60 * 60 * 1000,
    "max_distance_m": 5_000_000.0,
    # A run shorter than this is ignored for the leaderboard (misclicks).
    "min_duration_ms": 400,
}


# --------------------------------------------------------------------------
# Economy
# --------------------------------------------------------------------------

#: Coins banked per run = collected coins * this factor, rounded down.
COIN_BANK_RATE = 1.0

#: Bonus coins granted per 1000 m of distance, rewarding long runs.
COIN_DISTANCE_BONUS_PER_KM = 40


# --------------------------------------------------------------------------
# Shop catalog (server-authoritative)
# --------------------------------------------------------------------------
# The client renders this list but never decides prices or effects: purchases
# are validated and applied server-side against this table. ``levels`` is the
# number of purchasable tiers; price for the next tier is
# ``base_price * (growth ** current_level)``.

SHOP_CATALOG = [
    {
        "id": "magnet_duration",
        "name": "Magnet Coil",
        "desc": "Coin magnet lasts longer.",
        "icon": "magnet",
        "kind": "upgrade",
        "levels": 5,
        "base_price": 250,
        "growth": 1.9,
        "effect": {"stat": "magnetSeconds", "base": 6.0, "per_level": 1.6},
    },
    {
        "id": "shield_duration",
        "name": "Aegis Field",
        "desc": "Shield holds out longer.",
        "icon": "shield",
        "kind": "upgrade",
        "levels": 5,
        "base_price": 300,
        "growth": 1.9,
        "effect": {"stat": "shieldSeconds", "base": 5.0, "per_level": 1.4},
    },
    {
        "id": "turbo_duration",
        "name": "Ion Thrusters",
        "desc": "Turbo boost runs hotter and longer.",
        "icon": "turbo",
        "kind": "upgrade",
        "levels": 5,
        "base_price": 350,
        "growth": 2.0,
        "effect": {"stat": "turboSeconds", "base": 4.0, "per_level": 1.2},
    },
    {
        "id": "coin_value",
        "name": "Alloy Refinery",
        "desc": "Every coin is worth more score.",
        "icon": "coin",
        "kind": "upgrade",
        "levels": 5,
        "base_price": 400,
        "growth": 2.1,
        "effect": {"stat": "coinScore", "base": 10.0, "per_level": 4.0},
    },
    {
        "id": "head_start",
        "name": "Launch Rails",
        "desc": "Begin each run further down the line.",
        "icon": "rocket",
        "kind": "upgrade",
        "levels": 4,
        "base_price": 500,
        "growth": 2.2,
        "effect": {"stat": "headStartMetres", "base": 0.0, "per_level": 250.0},
    },
    {
        "id": "combo_grace",
        "name": "Flow State",
        "desc": "Combo chain survives longer between pickups.",
        "icon": "combo",
        "kind": "upgrade",
        "levels": 4,
        "base_price": 450,
        "growth": 2.0,
        "effect": {"stat": "comboGrace", "base": 2.2, "per_level": 0.45},
    },
    {
        "id": "hoverboard",
        "name": "Hoverboard",
        "desc": "Consumable. Survives one fatal hit.",
        "icon": "board",
        "kind": "consumable",
        "levels": 0,          # unlimited purchases
        "base_price": 150,
        "growth": 1.0,        # flat price
        "effect": {"stat": "hoverboards", "base": 0.0, "per_level": 1.0},
        "max_stock": 9,
    },
]

#: Cosmetic skins - purely visual, unlocked once.
SKIN_CATALOG = [
    {"id": "cyan", "name": "Cyan Default", "price": 0, "colors": ["#22e8ff", "#0b7fa8"]},
    {"id": "magenta", "name": "Hot Circuit", "price": 300, "colors": ["#ff3ea5", "#8c1550"]},
    {"id": "lime", "name": "Toxic Lime", "price": 300, "colors": ["#b9ff2e", "#4f8c15"]},
    {"id": "gold", "name": "Bullion", "price": 900, "colors": ["#ffd23e", "#8c6a15"]},
    {"id": "void", "name": "Void Walker", "price": 1500, "colors": ["#a06bff", "#4a2596"]},
]

#: Cap on the size of the opaque progress blob a client may store (bytes).
MAX_PROGRESS_BYTES = 8 * 1024


def shop_index() -> dict:
    """Return the shop catalog keyed by item id for O(1) lookups."""
    return {item["id"]: item for item in SHOP_CATALOG}


def skin_index() -> dict:
    """Return the skin catalog keyed by skin id."""
    return {skin["id"]: skin for skin in SKIN_CATALOG}


def price_for(item: dict, current_level: int) -> int:
    """
    Compute the cost of the next tier of ``item`` given ``current_level``.

    Consumables (``levels == 0``) use a flat price. Upgrades grow
    geometrically so each tier feels like a real commitment.
    """
    if item["levels"] == 0:
        return int(item["base_price"])
    return int(round(item["base_price"] * (item["growth"] ** current_level)))
