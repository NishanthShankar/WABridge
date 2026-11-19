#!/usr/bin/env python3
"""
WhatsApp alert for API key warnings (tenant key mismatch / refused).

Run every few minutes (launchd). It reads the server log from where it last stopped and:
- sends a message at once when a new caller appears: a tenant / key prefix / key length /
  method / route / kind combination never seen before;
- sends one digest a day (after DIGEST_HOUR_UTC) of all warnings since the last digest.
The first run only learns what is already in the log and sends nothing.

Configuration (environment):
  KEY_ALERT_TENANT_ID  tenant that sends the alert (its API key is read from master.db)
  KEY_ALERT_TO         phone number that receives it
  KEY_ALERT_LOG        server log (default logs/stdout.log)
  KEY_ALERT_STATE      state file (default logs/key-alert-state.json)
  KEY_ALERT_DRY_RUN=1  print instead of sending
Only key prefixes and lengths are ever read or sent, never keys.
"""
import collections
import datetime as dt
import json
import os
import pathlib
import sqlite3
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
LOG = pathlib.Path(os.environ.get("KEY_ALERT_LOG", ROOT / "logs" / "stdout.log"))
STATE = pathlib.Path(os.environ.get("KEY_ALERT_STATE", ROOT / "logs" / "key-alert-state.json"))
MASTER = ROOT / "apps" / "server" / "data" / "master.db"
TENANT = os.environ.get("KEY_ALERT_TENANT_ID", "")
TO = os.environ.get("KEY_ALERT_TO", "")
API = os.environ.get("KEY_ALERT_API", "http://localhost:4000")
DRY = os.environ.get("KEY_ALERT_DRY_RUN") == "1"
DIGEST_HOUR_UTC = 3  # about 09:00 in India
MARKERS = {
    "Tenant key mismatch": "allowed",
    "Tenant key refused": "refused",
    "key mismatch refused": "refused",
    "User key refused": "refused",
    "without a valid user key refused": "refused",
}


def kind_of(msg):
    for marker, kind in MARKERS.items():
        if marker in msg:
            return kind
    return None


def route(path):
    parts = (path or "").split("/")
    return "/".join(parts[:3]) if len(parts) > 2 else (path or "?")


def load_state():
    try:
        return json.loads(STATE.read_text())
    except Exception:
        return None


def save_state(state):
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state))
    tmp.replace(STATE)


def read_new(state):
    """Warning lines added since the last run. Starts over if the log was replaced or shrank."""
    stat = LOG.stat()
    offset = state.get("offset", 0)
    if state.get("inode") != stat.st_ino or stat.st_size < offset:
        offset = 0
    rows = []
    with LOG.open("rb") as f:
        f.seek(offset)
        for raw in f:
            if not raw.endswith(b"\n"):
                break  # a line still being written: read it next time
            offset += len(raw)
            line = raw.decode(errors="replace")
            if '"tenant-auth"' not in line and "key" not in line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            kind = kind_of(d.get("msg", ""))
            if kind:
                rows.append((d, kind))
    state["offset"], state["inode"] = offset, stat.st_ino
    return rows


def combo(d, kind):
    return "|".join(str(x) for x in (
        d.get("tenant") or "?", d.get("keyPrefix") or "?", d.get("keyLength", "?"),
        d.get("method") or "?", route(d.get("path")), kind))


def describe(d, kind):
    who = "no key" if d.get("keyPrefix") == "none" else \
        f"key {d.get('keyPrefix')}… (length {d.get('keyLength', '?')})"
    owner = d.get("keyTenant")
    if owner and owner == d.get("tenant"):
        # Names are not unique: the key belongs to a different tenant with the same name.
        who += f", the key of a different tenant also named {owner} (not this one)"
    elif owner:
        who += f", which is {owner}'s key"
    verdict = "ALLOWED (warn mode)" if kind == "allowed" else "refused"
    src = ", ".join(x for x in (d.get("ip") and f"from {d['ip']}", d.get("userAgent") and f"client {d['userAgent'][:60]}") if x)
    return f"• {d.get('tenant') or '?'}: {d.get('method')} {route(d.get('path'))} with {who} → {verdict}" + (f"\n  {src}" if src else "")


def api_key():
    con = sqlite3.connect(f"file:{MASTER}?mode=ro", uri=True)
    try:
        row = con.execute("select api_key from tenants where id = ?", (TENANT,)).fetchone()
    finally:
        con.close()
    if not row:
        raise SystemExit(f"tenant {TENANT} not found")
    return row[0]


def send(text):
    if DRY:
        print("---- would send ----\n" + text)
        return
    req = urllib.request.Request(
        f"{API}/api/messages",
        data=json.dumps({"phone": TO, "content": text}).encode(),
        headers={"Content-Type": "application/json", "X-API-Key": api_key()},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as res:
        if res.status >= 300:
            raise RuntimeError(f"send failed: {res.status}")


def main():
    if not DRY and (not TENANT or not TO):
        raise SystemExit("set KEY_ALERT_TENANT_ID and KEY_ALERT_TO")
    now = dt.datetime.now(dt.timezone.utc)
    state = load_state()
    first_run = state is None
    state = state or {"seen": [], "digest": {}, "lastDigest": now.date().isoformat()}
    seen = set(state["seen"])
    rows = read_new(state)

    fresh, fresh_lines = [], []
    for d, kind in rows:
        c = combo(d, kind)
        key = f"{d.get('tenant') or '?'} | {d.get('keyPrefix')} | {kind}"
        state["digest"][key] = state["digest"].get(key, 0) + 1
        if c not in seen:
            seen.add(c)
            fresh.append(c)
            fresh_lines.append(describe(d, kind))
    state["seen"] = sorted(seen)

    if first_run:
        state["digest"] = {}
        save_state(state)
        print(f"Learned {len(seen)} existing callers; alerts start from now.")
        return

    if fresh_lines:
        lines = fresh_lines[:15]
        more = len(fresh_lines) - len(lines)
        send("🔐 WABridge: new API caller without the right key\n\n" + "\n".join(lines)
             + (f"\n…and {more} more" if more else "")
             + "\n\nFull list: logs/key-mismatch-report.md")

    due = now.hour >= DIGEST_HOUR_UTC and state.get("lastDigest") != now.date().isoformat()
    if due:
        if state["digest"]:
            top = sorted(state["digest"].items(), key=lambda kv: -kv[1])[:12]
            send("🔐 WABridge daily key report\n\n"
                 + "\n".join(f"• {k}: {n}" for k, n in top)
                 + "\n\n'allowed' callers break once TENANT_KEY_CHECK=enforce.")
        state["digest"], state["lastDigest"] = {}, now.date().isoformat()

    save_state(state)


if __name__ == "__main__":
    try:
        main()
    except Exception as err:  # keep launchd quiet; the next run retries
        print(f"key-alert: {err}", file=sys.stderr)
        sys.exit(1)
