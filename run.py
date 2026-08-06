#!/usr/bin/env python3
"""
NEON RUSH - launcher.

    python run.py                 # serve on http://127.0.0.1:8000 and open it
    python run.py --port 9000     # pick a port (auto-advances if taken)
    python run.py --host 0.0.0.0  # expose on the LAN to play on your phone
    python run.py --no-browser    # just serve
    python run.py --reset-db      # wipe scores and start fresh

Requires nothing beyond the Python standard library (3.10+).
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
    parser.add_argument("--host", default=config.DEFAULT_HOST,
                        help=f"bind address (default: {config.DEFAULT_HOST})")
    parser.add_argument("--port", type=int, default=config.DEFAULT_PORT,
                        help=f"port; scans upward if busy (default: {config.DEFAULT_PORT})")
    parser.add_argument("--db", default=None,
                        help=f"SQLite path (default: {config.DEFAULT_DB_PATH})")
    parser.add_argument("--no-browser", action="store_true",
                        help="do not auto-open a browser window")
    parser.add_argument("--reset-db", action="store_true",
                        help="delete the existing database before starting")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="log every HTTP request")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    db_path = Path(args.db) if args.db else config.DEFAULT_DB_PATH
    if args.reset_db and db_path.exists():
        # WAL mode leaves sidecar files; remove them too for a clean slate.
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(db_path) + suffix)
            if candidate.exists():
                candidate.unlink()
        print(f"  Removed {db_path}")

    if not config.WEB_DIR.is_dir():
        print(f"error: frontend directory missing: {config.WEB_DIR}", file=sys.stderr)
        return 1

    serve(
        host=args.host,
        port=args.port,
        db_path=str(db_path),
        open_browser=not args.no_browser,
        verbose=args.verbose,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
