"""
Password hashing.

Uses bcrypt when it is installed and falls back to stdlib scrypt otherwise, so
the game still runs with zero pip dependencies while honouring `requirements.txt`
in a deployed container. The stored string carries its own algorithm tag, so
both formats coexist and old hashes keep verifying after bcrypt is added.

Format:
    bcrypt$<bcrypt hash>
    scrypt$<n>$<r>$<p>$<salt hex>$<derived key hex>
    pbkdf2$<iterations>$<salt hex>$<derived key hex>
"""

from __future__ import annotations

import hashlib
import hmac
import os

try:  # pragma: no cover - depends on the deployment environment
    import bcrypt as _bcrypt
except ImportError:  # pragma: no cover
    _bcrypt = None

# scrypt parameters: ~16 MB of memory per hash, which is a sane interactive cost.
_SCRYPT_N = 2 ** 14
_SCRYPT_R = 8
_SCRYPT_P = 1
_PBKDF2_ROUNDS = 240_000
_SALT_BYTES = 16
_DKLEN = 32

#: Longest password accepted. bcrypt silently truncates past 72 bytes, so the
#: limit is enforced here for every backend rather than varying by algorithm.
MAX_PASSWORD_LEN = 72
MIN_PASSWORD_LEN = 4


def hash_password(raw: str) -> str:
    """Hash a plaintext password. Returns an algorithm-tagged string."""
    data = _encode(raw)

    if _bcrypt is not None:
        return "bcrypt$" + _bcrypt.hashpw(data, _bcrypt.gensalt()).decode("ascii")

    salt = os.urandom(_SALT_BYTES)
    try:
        derived = hashlib.scrypt(
            data, salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, dklen=_DKLEN
        )
        return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${salt.hex()}${derived.hex()}"
    except (ValueError, AttributeError):
        # scrypt needs an OpenSSL build that provides it; pbkdf2 always exists.
        derived = hashlib.pbkdf2_hmac("sha256", data, salt, _PBKDF2_ROUNDS, dklen=_DKLEN)
        return f"pbkdf2${_PBKDF2_ROUNDS}${salt.hex()}${derived.hex()}"


def verify_password(raw: str, stored: str) -> bool:
    """Constant-time check of a plaintext password against a stored hash."""
    if not stored or raw is None:
        return False

    data = _encode(raw)
    algo, _, rest = stored.partition("$")

    try:
        if algo == "bcrypt":
            if _bcrypt is None:
                return False
            return _bcrypt.checkpw(data, rest.encode("ascii"))

        if algo == "scrypt":
            n, r, p, salt_hex, hash_hex = rest.split("$")
            expected = bytes.fromhex(hash_hex)
            derived = hashlib.scrypt(
                data, salt=bytes.fromhex(salt_hex),
                n=int(n), r=int(r), p=int(p), dklen=len(expected),
            )
            return hmac.compare_digest(derived, expected)

        if algo == "pbkdf2":
            rounds, salt_hex, hash_hex = rest.split("$")
            expected = bytes.fromhex(hash_hex)
            derived = hashlib.pbkdf2_hmac(
                "sha256", data, bytes.fromhex(salt_hex), int(rounds), dklen=len(expected)
            )
            return hmac.compare_digest(derived, expected)
    except (ValueError, TypeError):
        return False

    return False


def _encode(raw: str) -> bytes:
    """Normalise to bytes and clamp to the bcrypt-safe length."""
    return str(raw or "").encode("utf-8")[:MAX_PASSWORD_LEN]
