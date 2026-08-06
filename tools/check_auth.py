"""Manual check of the password endpoints against a running server."""

import json
import sqlite3
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8123"
NAME = f"PW{str(int(time.time()))[-7:]}"


def post(path, body):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.load(resp)


def get(path, token=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    req = urllib.request.Request(BASE + path, headers=headers)
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.load(resp)


fails = []

# --- migration landed on the real database ---
conn = sqlite3.connect("data/neonrush.sqlite3")
cols = {r[1] for r in conn.execute("PRAGMA table_info(players)")}
print("password_hash column present:", "password_hash" in cols)
if "password_hash" not in cols:
    fails.append("migration did not add password_hash")
legacy = conn.execute(
    "SELECT COUNT(*) FROM players WHERE password_hash = ''"
).fetchone()[0]
print(f"legacy accounts with no password: {legacy} (they can still sign in)")
conn.close()

# --- claim with a password ---
claimed = post("/api/claim-name", {"username": NAME, "password": "hunter22"})
print("claim ok:", bool(claimed.get("token")), "| hasPassword:", claimed.get("hasPassword"))
if not claimed.get("token"):
    fails.append("claim did not return a token")

# --- the probe reports it as protected ---
probe = get(f"/api/name-available?name={NAME}")
print("probe -> available:", probe["available"], "| hasPassword:", probe["hasPassword"])
if probe["available"] or not probe["hasPassword"]:
    fails.append("probe did not report the name as protected")

# --- wrong password is refused ---
bad = post("/api/verify-name", {"username": NAME, "password": "wrong"})
print("wrong password ->", bad.get("error"))
if bad.get("error") != "invalid_password" or bad.get("token"):
    fails.append("wrong password was not refused")

# --- correct password returns a token, and it is a NEW one ---
good = post("/api/verify-name", {"username": NAME, "password": "hunter22"})
print("correct password -> token:", bool(good.get("token")))
if not good.get("token"):
    fails.append("correct password did not return a token")
if good.get("token") == claimed.get("token"):
    fails.append("token was not rotated on sign-in")
else:
    print("token rotated on sign-in: True")

# --- the old token must now be dead ---
try:
    get("/api/me", claimed["token"])
    fails.append("old token still works after rotation")
except urllib.error.HTTPError as exc:
    print("old token rejected:", exc.code)

# --- the new token works ---
me = get("/api/me", good["token"])
print("new token -> name:", me["player"]["name"])
if me["player"]["name"] != NAME:
    fails.append("new token resolved to the wrong player")

# --- password hash must never appear in the profile payload ---
if "password" in json.dumps(me).lower():
    fails.append("password data leaked in the profile payload")
else:
    print("no password data in profile payload")

# --- unknown name gives the same error as a wrong password ---
unknown = post("/api/verify-name", {"username": "NOSUCHUSER99", "password": "x"})
print("unknown name ->", unknown.get("error"))
if unknown.get("error") != "invalid_password":
    fails.append("unknown name is distinguishable from a wrong password")

# --- claiming without a password still works ---
open_name = NAME + "B"
opened = post("/api/claim-name", {"username": open_name, "password": ""})
print("passwordless claim ok:", bool(opened.get("token")))
if not opened.get("token"):
    fails.append("passwordless claim failed")

# --- a legacy/passwordless account can set one on return ---
adopted = post("/api/verify-name", {"username": open_name, "password": "newpass1"})
print("passwordless account adopted a password:", bool(adopted.get("token")))
after = post("/api/verify-name", {"username": open_name, "password": "wrongone"})
if after.get("error") != "invalid_password":
    fails.append("password was not applied to the legacy account")
else:
    print("that password is now enforced")

# --- too-short passwords are refused ---
short = post("/api/claim-name", {"username": NAME + "C", "password": "ab"})
print("short password ->", short.get("error"))
if short.get("error") != "password_too_short":
    fails.append("short password was accepted")

print()
if fails:
    print(f"FAIL: {len(fails)} problem(s)")
    for f in fails:
        print("  -", f)
    raise SystemExit(1)
print("PASS: password claim, verify, rotation and isolation all behave.")
