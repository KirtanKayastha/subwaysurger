"""
Developer utility: normalise smart punctuation to ASCII in source files.

Editors and LLM-generated text love em-dashes and arrows; keeping the source
pure ASCII avoids encoding surprises when the files are served or diffed.
Run from the project root:  python tools/ascii_check.py [--fix]
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Directories that are never rewritten (third-party / generated / virtualenvs).
SKIP_PARTS = {
    "vendor", "data", "__pycache__", ".git", "node_modules",
    ".venv", "venv", "env", "site-packages", ".mypy_cache", ".pytest_cache",
}

EXTENSIONS = {".js", ".css", ".html", ".py", ".sql", ".md"}

REPLACEMENTS = {
    "\u2192": "->", "\u2190": "<-", "\u2194": "<->",
    "\u2014": "-", "\u2013": "-", "\u2212": "-",
    "\u2026": "...",
    "\u2018": "'", "\u2019": "'", "\u201a": "'",
    "\u201c": '"', "\u201d": '"',
    "\u00d7": "x", "\u00b7": "*", "\u2022": "*",
    "\u00b0": " deg", "\u00b1": "+/-",
    "\u2265": ">=", "\u2264": "<=", "\u2260": "!=",
    "\u00a0": " ", "\u200b": "",
    "\u2713": "OK", "\u2717": "X",
    "\u2191": "Up", "\u2193": "Down",
}


def iter_files():
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.suffix not in EXTENSIONS:
            continue
        if SKIP_PARTS & set(path.parts):
            continue
        yield path


def main() -> int:
    fix = "--fix" in sys.argv
    problems = 0

    for path in iter_files():
        try:
            text = io.open(path, encoding="utf-8").read()
        except (UnicodeDecodeError, OSError):
            continue

        updated = text
        for src, dst in REPLACEMENTS.items():
            updated = updated.replace(src, dst)

        leftover = sorted({c for c in updated if ord(c) > 127})
        rel = path.relative_to(ROOT)

        if updated != text and fix:
            io.open(path, "w", encoding="utf-8", newline="\n").write(updated)
            print(f"fixed    {rel}")

        if leftover:
            problems += 1
            codes = ", ".join(f"U+{ord(c):04X}" for c in leftover[:8])
            print(f"non-ascii {rel}: {codes}")

    print("no non-ascii remaining" if problems == 0 else f"{problems} file(s) still contain non-ascii")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
