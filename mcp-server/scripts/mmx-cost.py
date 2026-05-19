#!/usr/bin/env python3
"""Summarize MiniMax MCP delegation cost from server.log."""

import json
import os
import sys
from collections import defaultdict
from datetime import date, timedelta

LOG_PATH = os.environ.get("MINIMAX_MCP_LOG_PATH") or os.path.expanduser("~/.minimax-mcp/server.log")


def parse_args(argv):
    days = 1
    if len(argv) > 1:
        try:
            days = int(argv[1])
        except ValueError:
            print(f"usage: {argv[0]} [days_back=1]", file=sys.stderr)
            sys.exit(2)
    return days


def summarize(days_back):
    if not os.path.exists(LOG_PATH):
        print(f"No log at {LOG_PATH} — has the MCP server been invoked yet?")
        return 0

    cutoff = (date.today() - timedelta(days=days_back - 1)).isoformat()
    by_engine = defaultdict(lambda: {"count": 0, "cost": 0.0, "duration_ms": 0})
    issues = []
    total_calls = 0
    total_cost = 0.0

    with open(LOG_PATH) as f:
        for line in f:
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            if o.get("kind") != "delegate_end":
                continue
            ts = o.get("ts", "")
            if ts < cutoff:
                continue
            engine = o.get("engine_used") or "unknown"
            cost = o.get("cost_usd") or 0.0
            duration = o.get("duration_ms") or 0
            stop_reason = o.get("stop_reason", "?")
            by_engine[engine]["count"] += 1
            by_engine[engine]["cost"] += cost
            by_engine[engine]["duration_ms"] += duration
            total_calls += 1
            total_cost += cost
            if stop_reason != "completed":
                issues.append((engine, stop_reason, ts))

    label = "Today" if days_back == 1 else f"Last {days_back} days"
    print(f"=== MiniMax MCP usage — {label} (since {cutoff}) ===")
    if not total_calls:
        print("No completed delegations in window.")
        return 0
    print(f"Total: {total_calls} delegations  ${total_cost:.4f}")
    for engine in sorted(by_engine, key=lambda k: -by_engine[k]["count"]):
        v = by_engine[engine]
        avg_ms = v["duration_ms"] // max(v["count"], 1)
        print(f"  {engine}: {v['count']} calls  ${v['cost']:.4f}  avg {avg_ms} ms")
    if issues:
        print(f"\nNon-completed outcomes ({len(issues)}):")
        for engine, reason, ts in issues[:10]:
            print(f"  {ts}  {engine}: {reason}")
        if len(issues) > 10:
            print(f"  ... +{len(issues) - 10} more")
    return 0


if __name__ == "__main__":
    sys.exit(summarize(parse_args(sys.argv)))
