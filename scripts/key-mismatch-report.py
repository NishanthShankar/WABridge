#!/usr/bin/env python3
"""
Summarise requests that reached a tenant's subdomain without that tenant's API key.

While TENANT_KEY_CHECK=warn these are let through and logged as "Tenant key mismatch".
Run this before switching to enforce: every caller listed here would get 401.

Usage: key-mismatch-report.py [log file ...] > report.md
Defaults to logs/stdout.log next to this repo. Only key prefixes are ever logged or shown.
"""
import collections
import datetime as dt
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = [pathlib.Path(p) for p in sys.argv[1:]] or [ROOT / "logs" / "stdout.log"]
MARKERS = ("Tenant key mismatch", "key mismatch refused", "User key refused",
           "without a valid user key refused")


def when(t):
    if isinstance(t, (int, float)):
        return dt.datetime.fromtimestamp(t / 1000, dt.timezone.utc)
    return dt.datetime.fromisoformat(str(t).replace("Z", "+00:00"))


def route(path):
    parts = (path or "").split("/")
    return "/".join(parts[:3]) if len(parts) > 2 else path or "?"


now = dt.datetime.now(dt.timezone.utc)
groups = collections.defaultdict(lambda: {"n": 0, "n24": 0, "first": None, "last": None})
for f in FILES:
    if not f.exists():
        continue
    for line in f.open(errors="replace"):
        if not any(m in line for m in MARKERS):
            continue
        try:
            d = json.loads(line)
            t = when(d["time"])
        except Exception:
            continue
        key = (d.get("tenant") or "?", d.get("keyPrefix") or "?", d.get("keyTenant") or "-",
               d.get("method") or "?", route(d.get("path")), d.get("msg", ""))
        g = groups[key]
        g["n"] += 1
        if now - t < dt.timedelta(hours=24):
            g["n24"] += 1
        g["first"] = min(g["first"] or t, t)
        g["last"] = max(g["last"] or t, t)

fmt = "%Y-%m-%d %H:%M"
print(f"# Tenant key mismatches\n\nGenerated {now.strftime(fmt)} UTC from {', '.join(str(f) for f in FILES)}.\n")
if not groups:
    print("None found.")
    sys.exit(0)
print("`keyPrefix` is the first 8 characters sent (`none` = no key). `keyTenant` is whose key it is (`-` = nobody's).")
print("Every row here would get 401 once TENANT_KEY_CHECK=enforce.\n")
print("| Tenant | keyPrefix | keyTenant | Method | Route | Total | Last 24 h | First seen (UTC) | Last seen (UTC) |")
print("|---|---|---|---|---|---|---|---|---|")
for (tenant, prefix, owner, method, rt, _msg), g in sorted(
        groups.items(), key=lambda kv: kv[1]["last"], reverse=True):
    print(f"| {tenant} | `{prefix}` | {owner} | {method} | {rt} | {g['n']} | {g['n24']} | "
          f"{g['first'].strftime(fmt)} | {g['last'].strftime(fmt)} |")

active = {(k[0], k[1]) for k, g in groups.items() if g["n24"]}
print(f"\n**Callers seen in the last 24 h:** {len(active)}" +
      ("".join(f"\n- {t} with `{p}`" for t, p in sorted(active)) if active else ""))
