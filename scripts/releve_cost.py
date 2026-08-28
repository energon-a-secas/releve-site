"""Releve pricing engine.

The one place a dollar figure is derived from a token count. Both releve-scan.py
and releve-mini.py import this; js/cost.js is the browser mirror, and
data/testcases.json is the fixture that keeps the two honest.

Six rules, all of which the old tooling/costs/claude-costs.py broke:

1. Resolve rates per turn, from that turn's own message.model. Never per session.
2. Never substitute a different model's rates. Exact id, then longest declared
   prefix, then UNPRICED. An unpriced model is reported in its own bucket with a
   reason, never folded into a total and never treated as zero.
3. Split the cache writes: 5-minute at 1.25x base input, 1-hour at 2.0x.
4. Honour usage.speed. Fast mode on Opus bills double.
5. usage.iterations[] is authoritative when present, and is never ADDED to the
   top-level counters. Measured on 115,192 real turns: on all 77,063
   single-iteration turns the sum of iterations equals the top-level counters
   exactly, and on every multi-iteration turn the top-level counters equal the
   LAST iteration alone, so the sum is larger and the top level under-reports.
   Adding the two together double-counts; ignoring the array under-counts a
   multi-iteration turn. Summing the array and using it in place of the top
   level is correct in both cases.
6. Count each billed response once, keyed on message.id and not on the entry
   uuid. See turn_key() for the measurement: this is the rule with the largest
   consequence of any here, because getting it wrong doubles the whole bill
   while every individual turn still looks correctly priced.

usage.service_tier scales every rate: batch is half price. A tier whose pricing
is not a flat multiple of standard (priority) is priced at standard and flagged
tier_assumed, never guessed at. usage.inference_geo is not a pricing signal: it
reads "not_available" or "" in practice, which is why the old script's
--pricing regional flag changed a printed label and never a rate.

output_tokens_details.thinking_tokens is already inside output_tokens. It is
carried as a label and never added to cost.

Stdlib only, by design: these scripts are meant to be curled and run.
"""

import json
import os
import urllib.request

RATES_URL = "https://releve.neorgon.com/data/rates.json"

# Kept in sync with data/rates.json. A downloaded single-file script must work
# offline, so the table is embedded; --rates or --rates-refresh overrides it.
EMBEDDED_RATES = {
    "schema": "releve-rates/v1",
    "version": "2026-08-27",
    "verified": "2026-08-27",
    "source": "https://claude.com/pricing",
    "multipliers": {
        "cache_write_5m": 1.25,
        "cache_write_1h": 2.0,
        "cache_read": 0.1,
        "batch": 0.5,
    },
    "service_tiers": {
        "standard": {"multiplier": 1.0},
        "batch": {"multiplier": 0.5},
        "priority": {"multiplier": None},
    },
    "models": {
        "claude-opus-5": {
            "family": "opus", "context": 1000000,
            "periods": [{"from": None, "to": None, "input": 5.0, "output": 25.0}],
            "speed": {"fast": {"input": 10.0, "output": 50.0}},
        },
        "claude-fable-5": {
            "family": "fable", "context": 1000000,
            "periods": [{"from": None, "to": None, "input": 10.0, "output": 50.0}],
        },
        "claude-mythos-5": {
            "family": "fable", "context": 1000000,
            "periods": [{"from": None, "to": None, "input": 10.0, "output": 50.0}],
        },
        "claude-sonnet-5": {
            "family": "sonnet", "context": 1000000,
            "periods": [
                {"from": None, "to": "2026-08-31", "input": 2.0, "output": 10.0},
                {"from": "2026-09-01", "to": None, "input": 3.0, "output": 15.0},
            ],
        },
        "claude-opus-4-8": {
            "family": "opus", "context": 1000000,
            "periods": [{"from": None, "to": None, "input": 5.0, "output": 25.0}],
            "speed": {"fast": {"input": 10.0, "output": 50.0}},
        },
        "claude-opus-4-7": {
            "family": "opus", "context": 1000000,
            "periods": [{"from": None, "to": None, "input": 5.0, "output": 25.0}],
        },
        "claude-opus-4-6": {
            "family": "opus", "context": 1000000,
            "periods": [{"from": None, "to": None, "input": 5.0, "output": 25.0}],
        },
        "claude-opus-4-5": {
            "family": "opus", "context": 200000,
            "periods": [{"from": None, "to": None, "input": 5.0, "output": 25.0}],
        },
        "claude-sonnet-4-6": {
            "family": "sonnet", "context": 1000000,
            "periods": [{"from": None, "to": None, "input": 3.0, "output": 15.0}],
        },
        "claude-sonnet-4-5": {
            "family": "sonnet", "context": 200000,
            "periods": [{"from": None, "to": None, "input": 3.0, "output": 15.0}],
        },
        "claude-haiku-4-5": {
            "family": "haiku", "context": 200000,
            "periods": [{"from": None, "to": None, "input": 1.0, "output": 5.0}],
        },
        "claude-3-5-haiku": {
            "family": "haiku", "context": 200000,
            "periods": [{"from": None, "to": None, "input": 0.8, "output": 4.0}],
        },
        "kimi-k3": {
            "periods": None,
            "unpriced_reason": "Non-Anthropic model reached through a router. Unknown is not zero.",
        },
        "<synthetic>": {
            "excluded": True,
            "excluded_reason": "Generated locally without an API call. Never billed.",
        },
    },
}

MILLION = 1_000_000


# --------------------------------------------------------------------------
# Rate card loading
# --------------------------------------------------------------------------

def load_rates(source=None, refresh=False):
    """Return (rates_dict, provenance_string).

    Default is offline: a cost script should not make network calls unasked.
    """
    if source:
        if source.startswith(("http://", "https://")):
            with urllib.request.urlopen(source, timeout=15) as fh:
                return json.loads(fh.read().decode("utf-8")), source
        with open(source, encoding="utf-8") as fh:
            return json.load(fh), os.path.abspath(source)

    if refresh:
        try:
            with urllib.request.urlopen(RATES_URL, timeout=15) as fh:
                return json.loads(fh.read().decode("utf-8")), RATES_URL
        except Exception as exc:  # noqa: BLE001 - offline is a normal outcome
            return EMBEDDED_RATES, f"embedded (refresh failed: {exc})"

    # A rates.json sitting next to the script wins over the embedded copy.
    local = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "rates.json")
    if os.path.exists(local):
        with open(local, encoding="utf-8") as fh:
            return json.load(fh), os.path.abspath(local)

    return EMBEDDED_RATES, "embedded"


# --------------------------------------------------------------------------
# Model resolution
# --------------------------------------------------------------------------

UNPRICED = "unpriced"
EXCLUDED = "excluded"
PRICED = "priced"


def resolve_model(model_name, rates):
    """Map a transcript model id to a rate entry.

    Returns (canonical_id, entry, status). Rule 2: exact, then longest declared
    prefix, then UNPRICED. Never a fallback to some other model's rates, which is
    exactly how the old script reported every Opus 5 turn at Sonnet 4 prices.
    """
    if not model_name:
        return None, None, UNPRICED

    models = rates.get("models", {})

    if model_name in models:
        entry = models[model_name]
        if entry.get("excluded"):
            return model_name, entry, EXCLUDED
        if not entry.get("periods"):
            return model_name, entry, UNPRICED
        return model_name, entry, PRICED

    # Longest declared prefix, so claude-opus-4-6-20260115 finds claude-opus-4-6.
    # Bedrock/Vertex ids carry a region prefix (us.anthropic.claude-opus-5), so
    # try a suffix match too before giving up.
    candidates = [k for k in models if model_name.startswith(k) or model_name.endswith(k)]
    if candidates:
        key = max(candidates, key=len)
        entry = models[key]
        if entry.get("excluded"):
            return key, entry, EXCLUDED
        if not entry.get("periods"):
            return key, entry, UNPRICED
        return key, entry, PRICED

    return model_name, None, UNPRICED


def period_for(entry, date_str):
    """Pick the rate period covering date_str (YYYY-MM-DD). Last period wins if
    the date is absent, so an undated turn is priced at current rates."""
    periods = entry.get("periods") or []
    if not periods:
        return None
    if not date_str:
        return periods[-1]
    for period in periods:
        start, end = period.get("from"), period.get("to")
        if start and date_str < start:
            continue
        if end and date_str > end:
            continue
        return period
    return periods[-1]


def base_rates(entry, date_str, speed=None):
    """Return (input_rate, output_rate) for a model on a date at a speed."""
    period = period_for(entry, date_str)
    if period is None:
        return None, None

    if speed and speed != "standard":
        override = (entry.get("speed") or {}).get(speed)
        if override:
            return override["input"], override["output"]

    return period["input"], period["output"]


# --------------------------------------------------------------------------
# The cost of one turn
# --------------------------------------------------------------------------

def zero_cost():
    return {"input": 0.0, "output": 0.0, "cache_write": 0.0, "cache_read": 0.0, "total": 0.0}


def zero_tokens():
    return {
        "input": 0, "output": 0, "thinking": 0,
        "cache_write_5m": 0, "cache_write_1h": 0, "cache_read": 0,
    }


def _add_cache_write(tokens, source):
    """Read one record's cache-write counters into tokens. Returns True when the
    TTL split was missing and the flat counter had to be assumed 5-minute."""
    creation = source.get("cache_creation")
    if isinstance(creation, dict) and (
        "ephemeral_5m_input_tokens" in creation or "ephemeral_1h_input_tokens" in creation
    ):
        tokens["cache_write_5m"] += creation.get("ephemeral_5m_input_tokens") or 0
        tokens["cache_write_1h"] += creation.get("ephemeral_1h_input_tokens") or 0
        return False
    # No split available. Assume 5m, the default TTL, and mark the row.
    flat = source.get("cache_creation_input_tokens") or 0
    tokens["cache_write_5m"] += flat
    return flat > 0


def extract_tokens(usage):
    """Pull the six billable counters out of a usage object.

    Returns (tokens, estimated_cache_split, from_iterations).

    Rule 3: the 5m/1h split lives in cache_creation. A record carrying only the
    flat cache_creation_input_tokens is treated as 5m and flagged.
    Rule 5: a non-empty usage.iterations replaces the top-level counters, and is
    never added to them. See the module docstring for the measurement.
    """
    tokens = zero_tokens()
    if not isinstance(usage, dict):
        return tokens, False, False

    details = usage.get("output_tokens_details") or {}
    if isinstance(details, dict):
        # A label only. Already inside output_tokens, never added to cost.
        tokens["thinking"] = details.get("thinking_tokens") or 0

    iterations = usage.get("iterations")
    if isinstance(iterations, list) and iterations:
        estimated = False
        for it in iterations:
            if not isinstance(it, dict):
                continue
            tokens["input"] += it.get("input_tokens") or 0
            tokens["output"] += it.get("output_tokens") or 0
            tokens["cache_read"] += it.get("cache_read_input_tokens") or 0
            estimated = _add_cache_write(tokens, it) or estimated
        return tokens, estimated, True

    tokens["input"] = usage.get("input_tokens") or 0
    tokens["output"] = usage.get("output_tokens") or 0
    tokens["cache_read"] = usage.get("cache_read_input_tokens") or 0
    estimated = _add_cache_write(tokens, usage)

    return tokens, estimated, False


def tier_multiplier(rates, tier):
    """Return (multiplier, assumed). A tier with no published flat multiple is
    priced at standard and reported as an assumption, not silently discounted."""
    if not tier or tier == "standard":
        return 1.0, False
    tiers = rates.get("service_tiers") or EMBEDDED_RATES["service_tiers"]
    entry = tiers.get(tier)
    if not isinstance(entry, dict) or entry.get("multiplier") is None:
        return 1.0, True
    return entry["multiplier"], False


def price_tokens(tokens, entry, rates, date_str=None, speed=None, tier=None):
    """Cost a token bundle. Returns (cost_dict, status, tier_assumed)."""
    if entry is None or not entry.get("periods"):
        return zero_cost(), UNPRICED, False

    inp, out = base_rates(entry, date_str, speed)
    if inp is None:
        return zero_cost(), UNPRICED, False

    tier_mult, tier_assumed = tier_multiplier(rates, tier)
    inp *= tier_mult
    out *= tier_mult

    mult = rates.get("multipliers") or EMBEDDED_RATES["multipliers"]
    write_5m = inp * mult["cache_write_5m"]
    write_1h = inp * mult["cache_write_1h"]
    read = inp * mult["cache_read"]

    cost = {
        "input": tokens["input"] * inp / MILLION,
        "output": tokens["output"] * out / MILLION,
        "cache_write": (
            tokens["cache_write_5m"] * write_5m + tokens["cache_write_1h"] * write_1h
        ) / MILLION,
        "cache_read": tokens["cache_read"] * read / MILLION,
    }
    cost["total"] = cost["input"] + cost["output"] + cost["cache_write"] + cost["cache_read"]
    return cost, PRICED, tier_assumed


def price_turn(message, rates, date_str=None):
    """Cost one assistant turn.

    Returns a dict: model, canonical, status, tokens, cost, estimated_cache_split.
    """
    usage = (message or {}).get("usage")
    model_name = (message or {}).get("model")
    tokens, estimated, from_iterations = extract_tokens(usage)

    canonical, entry, status = resolve_model(model_name, rates)

    if status == EXCLUDED:
        return {
            "model": model_name, "canonical": canonical, "status": EXCLUDED,
            "tokens": tokens, "cost": zero_cost(), "estimated_cache_split": estimated,
            "tier": None, "tier_assumed": False, "from_iterations": from_iterations,
        }

    speed = usage.get("speed") if isinstance(usage, dict) else None
    tier = usage.get("service_tier") if isinstance(usage, dict) else None
    cost, priced, tier_assumed = price_tokens(tokens, entry, rates, date_str, speed, tier)

    return {
        "model": model_name,
        "canonical": canonical,
        "status": UNPRICED if status == UNPRICED else priced,
        "tokens": tokens,
        "cost": cost,
        "estimated_cache_split": estimated,
        "tier": tier,
        "tier_assumed": tier_assumed,
        "from_iterations": from_iterations,
    }


def turn_key(entry):
    """The dedup key for one *billed* API response.

    This is the sixth pricing rule, and the one that costs the most to get wrong.
    Claude Code writes one JSONL entry per content block of a response: a turn
    that thought, spoke and called a tool becomes three `type: "assistant"`
    entries with three different `uuid`s, and every one of them carries the same
    `usage` object. Deduping on `uuid` therefore dedupes nothing, and the same
    billed tokens are counted once per block.

    Measured on this machine: 116,402 assistant entries are 52,078 responses, and
    counting per uuid reports 30.02B cache-read tokens where the truth is 12.92B.
    A 2.3x overstatement of the whole bill, from a key that looks right.

    `message.id` is the API's own id for the response, so it is stable across the
    replay a resumed session writes into a new transcript too, which is what the
    richest-copy pass was originally built for.
    """
    message = entry.get("message")
    if isinstance(message, dict) and message.get("id"):
        return message["id"]
    return entry.get("uuid")


def uncached_cost(tokens, entry, rates, date_str=None, speed=None, tier=None):
    """The counterfactual: what this turn would have cost with no cache at all,
    every cache read and cache write repriced as fresh input. This is how the
    dashboard shows what the cache is actually saving."""
    if entry is None or not entry.get("periods"):
        return 0.0
    inp, out = base_rates(entry, date_str, speed)
    if inp is None:
        return 0.0
    tier_mult, _ = tier_multiplier(rates, tier)
    inp *= tier_mult
    out *= tier_mult
    fresh = tokens["input"] + tokens["cache_read"] + tokens["cache_write_5m"] + tokens["cache_write_1h"]
    return (fresh * inp + tokens["output"] * out) / MILLION


# --------------------------------------------------------------------------
# Accumulator
# --------------------------------------------------------------------------

def add_tokens(into, more):
    for key in into:
        into[key] += more.get(key, 0)


def add_cost(into, more):
    for key in into:
        into[key] += more.get(key, 0.0)


def billable_total(tokens):
    """Every counter that can carry a charge. thinking is excluded: it is already
    inside output. Used to pick the richest of several records for one turn."""
    return (
        tokens["input"] + tokens["output"] + tokens["cache_read"]
        + tokens["cache_write_5m"] + tokens["cache_write_1h"]
    )


class Bucket:
    """A running total of turns, tokens and cost for one dimension value.

    unpriced_turns is tracked separately so a row can never present an unpriced
    model as costing nothing: a bucket whose turns are all unpriced reports
    $0.00 with a count that says why.
    """

    __slots__ = ("turns", "tokens", "cost", "uncached", "unpriced_turns")

    def __init__(self):
        self.turns = 0
        self.tokens = zero_tokens()
        self.cost = zero_cost()
        self.uncached = 0.0
        self.unpriced_turns = 0

    def add(self, priced, uncached=0.0):
        self.turns += 1
        if priced["status"] == UNPRICED:
            self.unpriced_turns += 1
        add_tokens(self.tokens, priced["tokens"])
        add_cost(self.cost, priced["cost"])
        self.uncached += uncached

    def as_dict(self, key=None):
        out = {
            "turns": self.turns,
            "unpriced_turns": self.unpriced_turns,
            "tokens": dict(self.tokens),
            "cost": {k: round(v, 6) for k, v in self.cost.items()},
            "uncached_cost": round(self.uncached, 6),
        }
        if key is not None:
            out["key"] = key
        return out
