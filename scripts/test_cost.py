#!/usr/bin/env python3
"""Assert the Python pricing engine against data/testcases.json.

The same fixture is asserted in the browser by js/cost.js, which is what keeps
the two implementations from drifting. Run this before touching either.

    python3 scripts/test_cost.py [--rates data/rates.json] [-v]

Exits non-zero on the first failing case, so it works as a pre-commit gate.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from releve_cost import (  # noqa: E402
    EMBEDDED_RATES,
    load_rates,
    price_turn,
    resolve_model,
    turn_key,
    uncached_cost,
)

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "..", "data", "testcases.json")
RATES = os.path.join(HERE, "..", "data", "rates.json")


def flatten(prefix, obj, into):
    """Flatten a nested dict to dotted keys, for readable diffs."""
    for key, value in obj.items():
        path = f"{prefix}.{key}" if prefix else key
        if isinstance(value, dict):
            flatten(path, value, into)
        else:
            into[path] = value
    return into


def check_case(case, rates, tol):
    """Return a list of failure strings for one case. Empty means it passed."""
    expect = case["expect"]
    got = price_turn(case.get("message"), rates, case.get("date"))
    fails = []

    if "canonical" in expect and got["canonical"] != expect["canonical"]:
        fails.append(f"canonical: expected {expect['canonical']!r}, got {got['canonical']!r}")

    if "status" in expect and got["status"] != expect["status"]:
        fails.append(f"status: expected {expect['status']!r}, got {got['status']!r}")

    for flag in ("estimated_cache_split", "tier_assumed", "from_iterations"):
        if flag in expect and got.get(flag) != expect[flag]:
            fails.append(f"{flag}: expected {expect[flag]}, got {got.get(flag)}")

    for key, want in (expect.get("tokens") or {}).items():
        have = got["tokens"].get(key)
        if have != want:
            fails.append(f"tokens.{key}: expected {want}, got {have}")

    for key, want in (expect.get("cost") or {}).items():
        have = got["cost"].get(key)
        if have is None or abs(have - want) > tol:
            fails.append(f"cost.{key}: expected {want}, got {have}")

    if "uncached" in expect:
        _, entry, _ = resolve_model((case.get("message") or {}).get("model"), rates)
        usage = (case.get("message") or {}).get("usage") or {}
        have = uncached_cost(
            got["tokens"], entry, rates, case.get("date"),
            usage.get("speed"), usage.get("service_tier"),
        )
        if abs(have - expect["uncached"]) > tol:
            fails.append(f"uncached: expected {expect['uncached']}, got {have}")

    return fails


def check_dedup_case(case):
    """Rule 6: which entries are the same billed response.

    Cheap to test and expensive to get wrong. Every other case in this fixture
    prices one turn correctly; this one decides how many turns there are.
    """
    fails = []
    got = [turn_key(entry) for entry in case["entries"]]
    want = case["expect"]["keys"]
    if got != want:
        fails.append(f"keys: expected {want}, got {got}")
    return fails


def check_rate_card_parity(rates):
    """The embedded table in releve_cost.py must agree with data/rates.json.

    A downloaded single-file script uses the embedded copy, so a rate corrected
    in only one of the two ships a wrong number to whoever curled it.
    """
    fails = []
    if rates.get("version") != EMBEDDED_RATES["version"]:
        fails.append(
            f"version: rates.json {rates.get('version')!r} vs embedded {EMBEDDED_RATES['version']!r}"
        )

    if rates.get("multipliers"):
        for key, want in EMBEDDED_RATES["multipliers"].items():
            have = rates["multipliers"].get(key)
            if have != want:
                fails.append(f"multipliers.{key}: rates.json {have} vs embedded {want}")

    file_tiers = rates.get("service_tiers") or {}
    for tier, entry in EMBEDDED_RATES["service_tiers"].items():
        have = (file_tiers.get(tier) or {}).get("multiplier")
        if have != entry["multiplier"]:
            fails.append(
                f"service_tiers.{tier}.multiplier: rates.json {have!r} vs embedded {entry['multiplier']!r}"
            )

    file_models = rates.get("models") or {}
    for name, entry in EMBEDDED_RATES["models"].items():
        if name not in file_models:
            fails.append(f"models.{name}: in embedded table, missing from rates.json")
            continue
        other = file_models[name]
        if bool(entry.get("excluded")) != bool(other.get("excluded")):
            fails.append(f"models.{name}: excluded flag differs")
        a = flatten("", {"p": entry.get("periods") or []}, {})
        b = flatten("", {"p": other.get("periods") or []}, {})
        # Compare only the fields that affect money; rates.json also carries notes.
        for key in a:
            if key.endswith((".input", ".output", ".from", ".to")) and a[key] != b.get(key):
                fails.append(f"models.{name}.{key}: embedded {a[key]!r} vs rates.json {b.get(key)!r}")
        for speed, override in (entry.get("speed") or {}).items():
            theirs = (other.get("speed") or {}).get(speed) or {}
            for field in ("input", "output"):
                if override.get(field) != theirs.get(field):
                    fails.append(
                        f"models.{name}.speed.{speed}.{field}: "
                        f"embedded {override.get(field)!r} vs rates.json {theirs.get(field)!r}"
                    )

    for name in file_models:
        if name not in EMBEDDED_RATES["models"]:
            fails.append(f"models.{name}: in rates.json, missing from the embedded table")

    return fails


def main():
    ap = argparse.ArgumentParser(description="Releve pricing engine parity tests")
    ap.add_argument("--rates", default=RATES, help="rate card to test against")
    ap.add_argument("--fixture", default=FIXTURE, help="test case file")
    ap.add_argument("-v", "--verbose", action="store_true", help="print every case")
    args = ap.parse_args()

    with open(args.fixture, encoding="utf-8") as fh:
        fixture = json.load(fh)
    rates, provenance = load_rates(args.rates)
    tol = fixture.get("tolerance", 1e-9)

    dedup = fixture.get("dedup") or []
    print(f"releve engine parity  ·  {len(fixture['cases'])} pricing cases, "
          f"{len(dedup)} dedup cases")
    print(f"  fixture  {os.path.relpath(args.fixture)}")
    print(f"  rates    {os.path.relpath(provenance)}  (v{rates.get('version')})")
    print()

    if fixture.get("rates_version") and fixture["rates_version"] != rates.get("version"):
        print(
            f"  note: fixture targets rates v{fixture['rates_version']}, "
            f"loaded v{rates.get('version')}. Expected dollar figures may be stale."
        )
        print()

    failed = 0
    for case in fixture["cases"]:
        fails = check_case(case, rates, tol)
        if fails:
            failed += 1
            print(f"  FAIL  {case['name']}")
            print(f"        {case['why']}")
            for line in fails:
                print(f"        {line}")
        elif args.verbose:
            print(f"  ok    {case['name']}")

    for case in dedup:
        fails = check_dedup_case(case)
        if fails:
            failed += 1
            print(f"  FAIL  {case['name']}")
            print(f"        {case['why']}")
            for line in fails:
                print(f"        {line}")
        elif args.verbose:
            print(f"  ok    {case['name']}")

    card_fails = check_rate_card_parity(rates)
    if card_fails:
        print()
        print("  FAIL  rate card parity (releve_cost.EMBEDDED_RATES vs data/rates.json)")
        for line in card_fails:
            print(f"        {line}")

    print()
    total = len(fixture["cases"]) + len(dedup)
    if failed or card_fails:
        print(f"{total - failed}/{total} cases passed, {len(card_fails)} rate card mismatch(es)")
        return 1
    print(f"{total}/{total} cases passed, rate card in sync")
    return 0


if __name__ == "__main__":
    sys.exit(main())
