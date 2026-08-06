import sqlite3

conn = sqlite3.connect("data/neonrush.sqlite3")
idx = conn.execute(
    "SELECT name FROM sqlite_master WHERE type='index' "
    "AND name='idx_players_name_unique'"
).fetchone()
print("unique index present:", bool(idx))

total = conn.execute("SELECT COUNT(*) FROM players").fetchone()[0]
dupes = conn.execute(
    "SELECT COUNT(*) FROM (SELECT 1 FROM players GROUP BY LOWER(name) HAVING COUNT(*) > 1)"
).fetchone()[0]
print("players:", total, "duplicate name groups:", dupes)

print("sample names:", [r[0] for r in conn.execute(
    "SELECT name FROM players ORDER BY id LIMIT 10")])

# The constraint must actually be enforced at the storage layer.
try:
    first = conn.execute("SELECT name FROM players LIMIT 1").fetchone()[0]
    conn.execute(
        "INSERT INTO players (public_id, token_hash, name, created_ms, updated_ms) "
        "VALUES ('probe','probe',?,1,1)",
        (first.lower(),),
    )
    print("FAIL: duplicate insert was allowed")
except sqlite3.IntegrityError as exc:
    print("duplicate insert correctly rejected:", exc)
finally:
    conn.rollback()
    conn.close()
