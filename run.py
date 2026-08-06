#!/usr/bin/env python3
"""
NEON RUSH - launcher.

    python run.py                 # serve on http://127.0.0.1:8000 and open it
    python run.py --port 9000     # pick a port (auto-advances if taken)
    python run.py --host 0.0.0.0  # expose on the LAN to play on your phone
    python run.py --no-browser    # just serve
    python run.py --reset-db      # wipe scores and start fresh

Environment (used when the matching flag is not passed):
    PORT          bind port - set by most PaaS hosts
    HOST          bind address, defaults to 0.0.0.0 when PORT is set
    DATABASE_URL  database location; postgresql://, postgres://, sqlite://, or bare path
    NEONRUSH_DB   explicit SQLite path, takes precedence over DATABASE_URL

Requires python-dotenv, psycopg2-binary for deployment.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# Allow running from anywhere without installing the package.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from server.app import config  # noqa: E402
from server.app.server import serve  # noqa: E402

# Load a local .env if python-dotenv is available. Optional by design: the
# game must still start on a machine with nothing installed.
try:  # pragma: no cover - depends on the deployment environment
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # pragma: no cover
    pass


def is_postgres_url(url: str | None) -> bool:
    """Check if URL is PostgreSQL connection string."""
    if not url:
        return False
    return url.startswith("postgresql://") or url.startswith("postgres://")


def psycopg2_missing() -> bool:
    """True when the PostgreSQL driver is unavailable."""
    try:
        import psycopg2  # noqa: F401
    except ImportError:
        return True
    return False


def _env_port(default: int) -> int:
    """Port from $PORT, which is how PaaS hosts assign one."""
    raw = os.getenv("PORT")
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_host(default: str) -> str:
    """
    Bind address.

    When $PORT is set we are almost certainly in a container, where binding to
    loopback would make the service unreachable from outside it.
    """
    explicit = os.getenv("HOST")
    if explicit:
        return explicit
    return "0.0.0.0" if os.getenv("PORT") else default


def _env_db() -> str | None:
    """
    Database target from the environment.

    Returns either a PostgreSQL connection URL or a filesystem path for SQLite.
    """
    explicit = os.getenv("NEONRUSH_DB")
    if explicit:
        return explicit

    url = os.getenv("DATABASE_URL")
    if not url:
        return None

    # PostgreSQL: hand the URL through untouched.
    if is_postgres_url(url):
        if psycopg2_missing():
            print(
                "error: DATABASE_URL points at PostgreSQL but psycopg2 is not "
                "installed.\n"
                "       Install it with:  pip install psycopg2-binary",
                file=sys.stderr,
            )
            raise SystemExit(2)
        return url

    # SQLite URL forms and bare paths.
    if url.startswith("sqlite:///"):
        return url[len("sqlite:///"):]
    if url.startswith("sqlite://"):
        return url[len("sqlite://"):]
    if "://" not in url:
        return url

    scheme = url.split("://", 1)[0]
    print(
        f"error: DATABASE_URL uses an unsupported scheme '{scheme}://'.\n"
        f"       Supported: postgresql://, postgres://, sqlite:///<path>, or a "
        f"bare file path.",
        file=sys.stderr,
    )
    raise SystemExit(2)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="run.py",
        description="Serve the NEON RUSH endless runner.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Tip: use --host 0.0.0.0 and open http://<your-lan-ip>:8000 on a\n"
            "phone to play with touch controls."
        ),
    )
    parser.add_argument("--host", default=None,
                        help=f"bind address (default: $HOST or {config.DEFAULT_HOST})")
    parser.add_argument("--port", type=int, default=None,
                        help=f"port; scans upward if busy (default: $PORT or {config.DEFAULT_PORT})")
    parser.add_argument("--db", default=None,
                        help=f"database path/URL (default: $DATABASE_URL or {config.DEFAULT_DB_PATH})")
    parser.add_argument("--no-browser", action="store_true",
                        help="do not auto-open a browser window")
    parser.add_argument("--reset-db", action="store_true",
                        help="delete the existing database before starting")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="log every HTTP request")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    # Explicit flags win over the environment, which wins over the defaults.
    host = args.host if args.host is not None else _env_host(config.DEFAULT_HOST)
    port = args.port if args.port is not None else _env_port(config.DEFAULT_PORT)
    db_setting = args.db or _env_db()

    postgres = is_postgres_url(db_setting)
    print(f"DEBUG run.py: db_setting = {db_setting}", file=sys.stderr)

    if postgres:
        # A connection URL, not a path: no file handling applies.
        target = db_setting
        if args.reset_db:
            print(
                "error: --reset-db only applies to SQLite. Drop the tables on "
                "the server instead.",
                file=sys.stderr,
            )
            return 2
    else:
        db_path = Path(db_setting) if db_setting else config.DEFAULT_DB_PATH
        if args.reset_db and db_path.exists():
            # WAL mode leaves sidecar files; remove them too for a clean slate.
            for suffix in ("", "-wal", "-shm"):
                candidate = Path(str(db_path) + suffix)
                if candidate.exists():
                    candidate.unlink()
            print(f"  Removed {db_path}")
        # The parent directory may not exist on a fresh container volume.
        db_path.parent.mkdir(parents=True, exist_ok=True)
        target = str(db_path)

    if not config.WEB_DIR.is_dir():
        print(f"error: frontend directory missing: {config.WEB_DIR}", file=sys.stderr)
        return 1
    print(f"DEBUG run.py: target = {target}", file=sys.stderr) 

    # Never pop a browser in a container: there is none, and the attempt is a
    # pointless startup delay.
    open_browser = not args.no_browser and not os.getenv("PORT")

    serve(
        host=host,
        port=port,
        db_path=target,
        open_browser=open_browser,
        verbose=args.verbose,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())