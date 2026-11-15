#!/usr/bin/env python3
"""Summarise "tenant key mismatch" lines (tenant_key_check: warn) from the server log,
grouped by subdomain tenant, key prefix and the key's real owner.

Usage: scripts/key-mismatch-report.py [log file]   (default: logs/stdout.log)
"""
import collections
import datetime
import json
import os
import sys

log = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "logs", "stdout.log"
)

groups = collections.defaultdict(
    lambda: {"n": 0, "paths": collections.Counter(), "first": None, "last": None}
)
with open(log, errors="replace") as f:
    for line in f:
        if '"tenant key mismatch"' not in line:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        g = groups[(d.get("tenant"), d.get("keyPrefix"), d.get("keyOwner"))]
        g["n"] += 1
        g["paths"]["%s %s" % (d.get("method"), d.get("path"))] += 1
        t = d.get("time")
        g["first"] = t if g["first"] is None else min(g["first"], t)
        g["last"] = t if g["last"] is None else max(g["last"], t)

if not groups:
    print("No mismatches logged.")
    sys.exit()


def ts(ms):
    return datetime.datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M")


print("%-12s %-10s %-10s %6s  %-33s %s" % (
    "subdomain", "key prefix", "key owner", "count", "first / last seen", "top paths"))
for (tenant, prefix, owner), g in sorted(
    groups.items(), key=lambda kv: (kv[0][0] or "", -kv[1]["n"])
):
    paths = ", ".join("%s x%d" % (p, n) for p, n in g["paths"].most_common(3))
    print("%-12s %-10s %-10s %6d  %s / %s  %s" % (
        tenant, prefix, owner, g["n"], ts(g["first"]), ts(g["last"]), paths))
