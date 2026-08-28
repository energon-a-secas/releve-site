#!/usr/bin/env python3
"""Releve mini: one number, in about eighty lines.

    curl -O https://releve.neorgon.com/scripts/releve-mini.py
    curl -O https://releve.neorgon.com/scripts/releve_cost.py
    python3 releve-mini.py --days 30

It imports releve_cost.py rather than carrying its own copy of the rate table.
A second file is a smaller cost than two rate tables drifting apart, which is
the exact failure this project exists to fix. Everything else is here, short
enough to read before trusting: walk, filter, dedupe, price, print.

The total agrees with releve-scan.py to the cent on the same window. The
difference is that this prints one line and that one keeps the breakdown.
"""

import argparse
import glob
import json
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from releve_cost import (  # noqa: E402
    EXCLUDED,
    UNPRICED,
    billable_total,
    load_rates,
    price_turn,
    turn_key,
)


def main():
    ap = argparse.ArgumentParser(description="What your Claude Code work would cost at list rates")
    ap.add_argument("--days", type=int, default=30, help="window ending today (default 30)")
    ap.add_argument("--root", default=os.path.expanduser("~/.claude/projects"))
    ap.add_argument("--rates", help="rate card path or URL (default: offline)")
    args = ap.parse_args()

    rates, _ = load_rates(args.rates)
    since = (datetime.now(timezone.utc).date() - timedelta(days=args.days - 1)).isoformat()

    # response id -> the richest copy of that turn, as (billable tokens, one row).
    # Two things put the same billed usage in the file more than once: a response
    # is written one entry per content block, all carrying the same usage object,
    # and resuming a session replays its history into a new transcript. Counting
    # every copy is how a bill triples; keeping the first blindly can keep an
    # emptier one. turn_key() explains the key. Only the four fields below are
    # retained, so this holds kilobytes rather than the transcripts' gigabytes.
    best = {}
    loose = []  # turns with no key to dedupe on, counted as they come

    for path in sorted(glob.glob(os.path.join(args.root, "**", "*.jsonl"), recursive=True)):
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    entry = json.loads(line)
                except (ValueError, TypeError):
                    continue
                if not isinstance(entry, dict) or entry.get("type") != "assistant":
                    continue
                date = (entry.get("timestamp") or "")[:10]
                if not date or date < since:
                    continue  # per turn, so a straddling session is part-counted
                message = entry.get("message")
                if not isinstance(message, dict) or not isinstance(message.get("usage"), dict):
                    continue

                priced = price_turn(message, rates, date)
                row = (
                    priced["status"], priced["canonical"], priced["cost"]["total"],
                    entry.get("sessionId") or entry.get("session_id"),
                )
                weight = billable_total(priced["tokens"])
                uid = turn_key(entry)
                if not uid:
                    loose.append(row)
                elif uid not in best or weight > best[uid][0]:
                    best[uid] = (weight, row)

    total = 0.0
    turns = excluded_turns = unpriced_turns = 0
    unpriced_models = {}
    sessions = set()

    for status, canonical, cost, session_id in [r for _, r in best.values()] + loose:
        if status == EXCLUDED:
            excluded_turns += 1
            continue
        turns += 1
        if session_id:
            sessions.add(session_id)
        if status == UNPRICED:
            # Rule 2: an unknown rate is named, not quietly treated as free.
            unpriced_turns += 1
            name = canonical or "(no model)"
            unpriced_models[name] = unpriced_models.get(name, 0) + 1
        else:
            total += cost

    print(f"Releve  ·  {args.days} days  ·  {len(sessions):,} sessions  ·  {turns:,} turns")
    print(f"API-equivalent   ${total:,.2f}")
    if unpriced_turns:
        named = ", ".join(f"{m} ({n:,})" for m, n in sorted(unpriced_models.items()))
        print(f"  unpriced       {unpriced_turns:,} turns, not included: {named}")
    if excluded_turns:
        print(f"  excluded       {excluded_turns:,} turns, never billed")
    print(f"rates as of {rates.get('verified')}. A counterfactual at list rates, not an invoice.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
