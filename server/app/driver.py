"""
Database driver: backend selection, connection façade, SQL dialect translation.

The persistence layer in :mod:`db` is written in one SQL dialect. This module
adapts it to whichever backend is configured:

* **PostgreSQL** via psycopg2 - selected by a ``postgres://`` DATABASE_URL.
* **SQLite** - the fallback when no such URL is set. Keeps `python run.py`
  working on a machine with nothing installed, and keeps the test-suite's
  ``:memory:`` databases working.

Both paths go through :class:`Connection`, which exposes the small surface
``db.py`` actually uses: ``execute``, ``insert_id``, ``executescript``,
``commit``, ``rollback``, ``close``. Callers never see a raw DB-API object, so
the dialect differences stay in this file.

The translation is deliberately narrow: it handles exactly the constructs this
codebase uses. A general-purpose SQL rewriter is a losing battle, so anything
outside the list in :func:`to_postgres` must be branched at the call site
instead (see ``db.Database._migrate_unique_names``).
"""

from __future__ import annotations

import re
import sqlite3
from typing import Any, Iterable, Optional

try:  # pragma: no cover - depends on the deployment environment
    import psycopg2
    import psycopg2.extras
except ImportError:  # pragma: no cover
    psycopg2 = None


#: URL schemes that select the PostgreSQL backend.
_PG_SCHEMES = (
    "postgres://",
    "postgresql://",
    "postgres+psycopg2://",
    "postgresql+psycopg2://",
)


def is_postgres_url(value: Optional[Any]) -> bool:
    """Does this DATABASE_URL point at PostgreSQL?"""
    return bool(value) and str(value).startswith(_PG_SCHEMES)


def normalise_pg_url(url: str) -> str:
    """
    Make a URL psycopg2-friendly.

    SQLAlchemy-style ``+psycopg2`` suffixes are stripped, and ``sslmode`` is
    defaulted to ``require`` for hosted providers such as Neon, which refuse
    plaintext connections. An explicit sslmode is left alone, and local hosts
    are left plaintext since they rarely have TLS configured.
    """
    for prefix in ("postgresql+psycopg2://", "postgres+psycopg2://"):
        if url.startswith(prefix):
            url = "postgresql://" + url[len(prefix):]
            break

    if "sslmode=" not in url and not _is_local(url):
        url += ("&" if "?" in url else "?") + "sslmode=require"
    return url


def _is_local(url: str) -> bool:
    return any(host in url for host in ("@localhost", "@127.0.0.1", "@[::1]", "@::1"))


# --------------------------------------------------------------------------
# SQL translation
# --------------------------------------------------------------------------

#: Positional placeholder. No query in this codebase contains a literal '?'
#: inside a string literal, so a blanket substitution is safe here.
_PLACEHOLDER = re.compile(r"\?")

#: PRAGMA is SQLite-only; the whole statement is dropped for PostgreSQL.
_PRAGMA = re.compile(r"^\s*PRAGMA\b[^;]*;?\s*$", re.I | re.M)

#: Detects the SQLite-only INSERT OR IGNORE form.
_INSERT_OR_IGNORE = re.compile(r"\bINSERT\s+OR\s+IGNORE\s+INTO\b", re.I)

_REWRITES: tuple[tuple[re.Pattern[str], str], ...] = (
    # Auto-incrementing primary keys.
    (re.compile(r"INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT", re.I), "SERIAL PRIMARY KEY"),
    # SQLite's REAL storage class -> the SQL-standard spelling.
    (re.compile(r"\bREAL\b", re.I), "DOUBLE PRECISION"),
    # No per-column collation clause; case-insensitivity is done with LOWER().
    (re.compile(r"\s+COLLATE\s+NOCASE", re.I), ""),
    # MAX(col, ?) over two scalars. In PostgreSQL MAX() is strictly an
    # aggregate, so the two-argument form must become GREATEST().
    (re.compile(r"\bMAX\(\s*(\w+)\s*,\s*\?\s*\)", re.I), r"GREATEST(\1, ?)"),
)

#: SQLite has no GREATEST/LEAST; its MAX()/MIN() are overloaded to cover both
#: the aggregate and the scalar case. Shared SQL is written in the PostgreSQL
#: spelling, so these map it back.
_SQLITE_REWRITES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bGREATEST\s*\(", re.I), "MAX("),
    (re.compile(r"\bLEAST\s*\(", re.I), "MIN("),
)


def to_sqlite(sql: str) -> str:
    """Translate the shared dialect back to SQLite where the two differ."""
    for pattern, replacement in _SQLITE_REWRITES:
        sql = pattern.sub(replacement, sql)
    return sql


def strip_pragmas(sql: str) -> str:
    """Remove PRAGMA statements, which PostgreSQL rejects outright."""
    return _PRAGMA.sub("", sql)


def to_postgres(sql: str) -> str:
    """
    Translate the source dialect to PostgreSQL.

    Handles, in order:
      * ``INSERT OR IGNORE`` -> ``INSERT ... ON CONFLICT DO NOTHING``
      * ``INTEGER PRIMARY KEY AUTOINCREMENT`` -> ``SERIAL PRIMARY KEY``
      * ``REAL`` -> ``DOUBLE PRECISION``
      * ``COLLATE NOCASE`` -> removed (callers use ``LOWER()``)
      * ``MAX(col, ?)`` -> ``GREATEST(col, ?)``
      * ``?`` placeholders -> ``%s``

    PRAGMA removal is separate (:func:`strip_pragmas`) because it only applies
    to the schema script.
    """
    # First, while the OR IGNORE keyword is still present to detect. A
    # statement that already carries an explicit ON CONFLICT is left alone.
    if _INSERT_OR_IGNORE.search(sql):
        sql = _INSERT_OR_IGNORE.sub("INSERT INTO", sql)
        if "on conflict" not in sql.lower():
            sql = sql.rstrip().rstrip(";") + " ON CONFLICT DO NOTHING"

    for pattern, replacement in _REWRITES:
        sql = pattern.sub(replacement, sql)

    return _PLACEHOLDER.sub("%s", sql)


# --------------------------------------------------------------------------
# Connection façade
# --------------------------------------------------------------------------

class Connection:
    """
    Uniform wrapper over a psycopg2 or sqlite3 connection.

    Only the operations ``db.py`` needs are exposed. Every statement passes
    through :func:`to_postgres` when the backend is PostgreSQL, so call sites
    keep writing one dialect.
    """

    def __init__(self, raw: Any, *, postgres: bool) -> None:
        self._raw = raw
        self.postgres = postgres

    # -- queries ---------------------------------------------------------

    def execute(self, sql: str, params: Iterable[Any] = ()) -> Any:
        """Run a statement and return a cursor (fetchone/fetchall/rowcount)."""
        if not self.postgres:
            return self._raw.execute(to_sqlite(sql), tuple(params))
        cur = self._raw.cursor(cursor_factory=psycopg2.extras.DictCursor)
        cur.execute(to_postgres(sql), tuple(params))
        return cur

    def insert_id(self, sql: str, params: Iterable[Any] = (),
                  *, id_column: str = "id") -> Any:
        """
        Run an INSERT and return the generated primary key.

        psycopg2's ``lastrowid`` reports an OID rather than the SERIAL value,
        so PostgreSQL needs an explicit RETURNING clause. SQLite keeps using
        ``lastrowid``.
        """
        if not self.postgres:
            return self._raw.execute(to_sqlite(sql), tuple(params)).lastrowid
        cur = self._raw.cursor()
        cur.execute(f"{to_postgres(sql)} RETURNING {id_column}", tuple(params))
        row = cur.fetchone()
        return row[0] if row else None

    def executescript(self, sql: str) -> None:
        """Run a multi-statement script (the schema file)."""
        if not self.postgres:
            self._raw.executescript(to_sqlite(sql))
            return
        cur = self._raw.cursor()
        cur.execute(to_postgres(strip_pragmas(sql)))

    # -- transaction control ---------------------------------------------

    def begin(self) -> None:
        """
        Open an exclusive transaction.

        SQLite needs BEGIN IMMEDIATE to take the write lock up front, which is
        what makes read-modify-write sequences safe. psycopg2 already opens a
        transaction implicitly on first statement, so this is a no-op there.
        """
        if not self.postgres:
            self._raw.execute("BEGIN IMMEDIATE")

    def commit(self) -> None:
        self._raw.commit()

    def rollback(self) -> None:
        self._raw.rollback()

    def close(self) -> None:
        try:
            self._raw.close()
        except Exception:
            # Closing a already-dead connection must never propagate.
            pass

    @property
    def stale(self) -> bool:
        """
        Has the server dropped this connection?

        Hosted PostgreSQL (Neon in particular) closes idle connections, and a
        thread-local connection can sit unused for a long time between
        requests. Detecting it here lets the caller reconnect transparently.
        """
        if not self.postgres:
            return False
        return bool(getattr(self._raw, "closed", 0))

    # -- dialect-specific introspection ----------------------------------

    def index_exists(self, name: str) -> bool:
        """Is an index with this name defined?"""
        if self.postgres:
            row = self.execute(
                "SELECT 1 FROM pg_indexes WHERE indexname = ?", (name,)
            ).fetchone()
        else:
            row = self.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?",
                (name,),
            ).fetchone()
        return row is not None

    def column_names(self, table: str) -> set[str]:
        """Column names of a table, for additive migrations."""
        if self.postgres:
            rows = self.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = ?",
                (table,),
            ).fetchall()
            return {r[0] for r in rows}
        # PRAGMA takes no parameters, and the table name is a literal from
        # our own source rather than user input.
        rows = self.execute(f"PRAGMA table_info({table})").fetchall()
        return {r["name"] for r in rows}


def connect(target: str, *, postgres: bool) -> Connection:
    """Open a connection to ``target`` using the selected backend."""
    if postgres:
        if psycopg2 is None:
            raise RuntimeError(
                "DATABASE_URL points at PostgreSQL but psycopg2 is not installed.\n"
                "Install it with:  pip install psycopg2-binary"
            )
        raw = psycopg2.connect(normalise_pg_url(target))
        # Match the SQLite layer: explicit transactions, committed by tx().
        raw.autocommit = False
        return Connection(raw, postgres=True)

    if target == ":memory:":
        # Every plain in-memory connection gets its own private database; a
        # shared-cache URI keeps all threads pointed at one.
        raw = sqlite3.connect(
            "file:neonrush_test?mode=memory&cache=shared",
            uri=True, timeout=10.0, check_same_thread=False,
        )
    else:
        raw = sqlite3.connect(target, timeout=10.0, check_same_thread=False)

    raw.row_factory = sqlite3.Row
    raw.execute("PRAGMA foreign_keys = ON")
    raw.execute("PRAGMA busy_timeout = 10000")
    if target != ":memory:":
        raw.execute("PRAGMA journal_mode = WAL")
    raw.execute("PRAGMA synchronous = NORMAL")
    return Connection(raw, postgres=False)
