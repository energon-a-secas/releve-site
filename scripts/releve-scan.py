#!/usr/bin/env python3
"""Releve: read your Claude Code spend off the transcripts.

Walks ~/.claude/projects recursively, prices every assistant turn through
releve_cost.py, and writes a releve.json the dashboard at
https://releve.neorgon.com can load. Python 3 stdlib only.

    curl -O https://releve.neorgon.com/scripts/releve-scan.py
    curl -O https://releve.neorgon.com/scripts/releve_cost.py
    python3 releve-scan.py --days 30

What it does that a naive script does not:

  * Reads all three transcript tiers. <project>/*.jsonl is the main thread;
    <project>/<session>/subagents/*.jsonl and .../subagents/workflows/wf_*/
    hold subagent and workflow spend, which is most of the files.
  * Filters per turn, not per session, so a session straddling the window is
    partially counted rather than dropped whole.
  * Counts each billed response once, keyed on the API's own message.id rather
    than on the entry uuid. Claude Code writes one entry per content block of a
    response and repeats the same usage object on each, so a thinking + text +
    tool_use turn appears three times with three uuids and one bill. Resuming a
    session replays history into a new transcript on top of that. Counting every
    copy overstates cache reads here by 2.3x; keeping the first copy blindly can
    keep an incomplete record, because a later copy is sometimes richer. Both
    passes below exist for that: the winner is the copy with the most billable
    tokens.
  * Resolves the model per turn from that turn's own message.model.
  * Names an unpriced model instead of substituting a cheaper one.
  * Labels projects from each transcript's own cwd. The directory name is a
    lossy encoding: -Users-me-dev-Personal and
    -Users-me-Documents-Projects-Personal both end in "Personal".

Nothing in the output contains prompt or response text. Only usage counters and
labels. --anonymize additionally strips paths, branches and titles.
"""

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from releve_cost import (  # noqa: E402
    EXCLUDED,
    UNPRICED,
    Bucket,
    add_tokens,
    billable_total,
    extract_tokens,
    load_rates,
    price_turn,
    resolve_model,
    turn_key,
    uncached_cost,
    zero_tokens,
)

SCHEMA = "releve/v1"
GENERATOR = "releve-scan.py"
DEFAULT_ROOT = os.path.expanduser("~/.claude/projects")

# The dimensions every breakdown is cut by. lane is derived from the file's
# position in the tree plus isSidechain; the rest are transcript fields.
DIMENSIONS = ("model", "project", "skill", "effort", "branch", "lane", "tier", "version")


# --------------------------------------------------------------------------
# Discovery
# --------------------------------------------------------------------------

def find_transcripts(root, include_subagents=True):
    """Every .jsonl under root, at any depth. Returns [(path, lane)]."""
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        rel = os.path.relpath(dirpath, root)
        parts = [] if rel == "." else rel.split(os.sep)
        if "subagents" in parts:
            lane = "workflow" if "workflows" in parts else "subagent"
        else:
            lane = "main"
        if lane != "main" and not include_subagents:
            continue
        for name in sorted(filenames):
            if name.endswith(".jsonl"):
                found.append((os.path.join(dirpath, name), lane))
    return found


def project_label(cwd, home):
    """A readable, unambiguous project key from a session's cwd.

    Relative to $HOME when it lives there, so dev/Personal and
    Documents/Projects/Personal stay distinct instead of collapsing to
    "Personal" the way a basename does.
    """
    if not cwd:
        return None
    path = os.path.normpath(cwd)
    if home and path.startswith(home + os.sep):
        return os.path.relpath(path, home).replace(os.sep, "/")
    return path.replace(os.sep, "/")


def decode_dir_name(name, home):
    """Best-effort label for a transcript with no cwd on any entry.

    The directory name is the cwd with every non-alphanumeric run replaced by a
    dash, so it cannot be inverted reliably. Flagged as approximate.
    """
    stripped = name.lstrip("-")
    if home:
        prefix = home.lstrip("/").replace("/", "-")
        if stripped.startswith(prefix + "-"):
            stripped = stripped[len(prefix) + 1:]
    return (stripped.replace("-", "/") or name) + " (approx)"


# --------------------------------------------------------------------------
# Window
# --------------------------------------------------------------------------

def resolve_window(args):
    """Return (from_date, to_date) as YYYY-MM-DD strings or None."""
    if args.since or args.until:
        return args.since, args.until
    if args.days:
        today = datetime.now(timezone.utc).date()
        return (today - timedelta(days=args.days - 1)).isoformat(), None
    return None, None


def turn_date(entry):
    """The YYYY-MM-DD of a turn, from its own timestamp."""
    ts = entry.get("timestamp")
    if isinstance(ts, str) and len(ts) >= 10:
        return ts[:10]
    return None


# --------------------------------------------------------------------------
# Percentiles, for the projector's calibration block
# --------------------------------------------------------------------------

def percentile(values, p):
    """Nearest-rank percentile. Returns None for an empty sample."""
    if not values:
        return None
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, int(round((p / 100.0) * (len(ordered) - 1)))))
    return ordered[idx]


# --------------------------------------------------------------------------
# The scan
# --------------------------------------------------------------------------

class Scan:
    def __init__(self, rates, args):
        self.rates = rates
        self.args = args
        self.home = os.path.expanduser("~").rstrip(os.sep)

        self.turns = 0
        self.duplicate_turns = 0
        self.richer_duplicates = 0
        self.malformed_lines = 0
        self.files_read = 0
        self.files_skipped = 0

        self.tokens = Bucket().tokens
        self.cost = Bucket().cost
        self.uncached = 0.0

        self.estimated_split_turns = 0
        self.tier_assumed_turns = 0
        self.iteration_turns = 0
        self.multi_iteration_turns = 0

        self.unpriced_turns = 0
        self.unpriced_models = defaultdict(int)
        self.unpriced_tokens = Bucket().tokens
        self.excluded_turns = 0
        self.excluded_models = defaultdict(int)

        self.dims = {name: defaultdict(Bucket) for name in DIMENSIONS}
        self.days = defaultdict(lambda: defaultdict(Bucket))
        self.day_tot = defaultdict(Bucket)
        self.sessions = {}

        # Per-day slices of every dimension, so a date brush on the site can
        # refilter the breakdowns instead of only the timeline. Deliberately
        # thin: [turns, cost, unpriced_turns] per key, not the full token
        # breakdown. `dimensions` stays the rich window-wide rollup; this is the
        # brushable projection of it, and costs about 3 KB per day.
        self.day_dims = defaultdict(
            lambda: defaultdict(lambda: defaultdict(lambda: [0, 0.0, 0]))
        )

        # Cross-tab of dimension key by rate key, tokens only. The site's rate
        # editor reprices from tokens, and no bucket's cost can be repriced from
        # its own total: a project's bill depends on which models spent it. Keyed
        # by rate key rather than by model so a fast-mode turn keeps its doubled
        # rate and a batch-tier turn keeps its half rate.
        self.dim_rates = {
            name: defaultdict(lambda: defaultdict(zero_tokens)) for name in DIMENSIONS
        }
        self.rate_keys = {}

        # turn key -> the largest billable token count seen for that response.
        # Pass 1 fills it; pass 2 accepts the first copy matching the winner and
        # drops the key, so the same dict doubles as the "already counted" set.
        # The key is the API's response id, not the entry uuid: see turn_key().
        self.best = {}

        # Calibration samples: model -> effort -> list of per-turn counters.
        self.calib = defaultdict(lambda: defaultdict(lambda: {
            "input": [], "output": [], "cache_read": [], "cache_write": [],
        }))
        self.first_date = None
        self.last_date = None

    # -- ingest ---------------------------------------------------------

    def read_file(self, path, lane, pass_no):
        """One pass over one transcript. Pass 1 only records which copy of each
        turn is the richest; pass 2 does the accounting."""
        cwd = None
        rows = []

        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except (ValueError, TypeError):
                        if pass_no == 2:
                            self.malformed_lines += 1
                        continue
                    if not isinstance(entry, dict):
                        if pass_no == 2:
                            self.malformed_lines += 1
                        continue
                    if cwd is None and entry.get("cwd"):
                        cwd = entry["cwd"]
                    if entry.get("type") == "assistant":
                        rows.append(entry)
        except OSError:
            if pass_no == 2:
                self.files_skipped += 1
            return

        if pass_no == 1:
            for entry in rows:
                self.note_turn(entry)
            return

        self.files_read += 1
        project = project_label(cwd, self.home)
        if project is None:
            root = os.path.abspath(self.args.root)
            rel = os.path.relpath(path, root)
            project = decode_dir_name(rel.split(os.sep)[0], self.home)

        for entry in rows:
            self.add_turn(entry, project, lane)

    def in_window(self, date):
        if self.args.since and (date is None or date < self.args.since):
            return False
        if self.args.until and (date is None or date > self.args.until):
            return False
        return True

    @staticmethod
    def turn_weight(message):
        """Billable tokens on one copy of a turn, for choosing between copies."""
        tokens, _, _ = extract_tokens(message.get("usage"))
        return billable_total(tokens)

    def note_turn(self, entry):
        """Pass 1: remember the richest copy of each turn."""
        if not self.in_window(turn_date(entry)):
            return
        uid = turn_key(entry)
        message = entry.get("message")
        if not uid or not isinstance(message, dict) or not isinstance(message.get("usage"), dict):
            return
        weight = self.turn_weight(message)
        if uid in self.best:
            self.duplicate_turns += 1
            if weight > self.best[uid]:
                self.richer_duplicates += 1
                self.best[uid] = weight
        else:
            self.best[uid] = weight

    def add_turn(self, entry, project, file_lane):
        date = turn_date(entry)
        if not self.in_window(date):
            return

        message = entry.get("message")
        if not isinstance(message, dict):
            return
        usage = message.get("usage")
        if not isinstance(usage, dict):
            return

        uid = turn_key(entry)
        if uid:
            best = self.best.get(uid)
            if best is None:
                return  # already counted, or a losing copy of a counted turn
            if self.turn_weight(message) < best:
                return  # a poorer copy; the richer one is still to come
            del self.best[uid]

        priced = price_turn(message, self.rates, date)

        if priced["status"] == EXCLUDED:
            self.excluded_turns += 1
            self.excluded_models[priced["canonical"] or "?"] += 1
            return

        self.turns += 1
        if date:
            self.first_date = date if self.first_date is None else min(self.first_date, date)
            self.last_date = date if self.last_date is None else max(self.last_date, date)

        if priced["estimated_cache_split"]:
            self.estimated_split_turns += 1
        if priced["tier_assumed"]:
            self.tier_assumed_turns += 1
        if priced["from_iterations"]:
            self.iteration_turns += 1
            if len(usage.get("iterations") or ()) > 1:
                self.multi_iteration_turns += 1

        tokens = priced["tokens"]

        if priced["status"] == UNPRICED:
            # Rule 2. Counted and named, never folded into a priced total.
            self.unpriced_turns += 1
            self.unpriced_models[priced["canonical"] or "(no model)"] += 1
            for key in self.unpriced_tokens:
                self.unpriced_tokens[key] += tokens[key]
            uncached = 0.0
        else:
            for key in self.tokens:
                self.tokens[key] += tokens[key]
            for key in self.cost:
                self.cost[key] += priced["cost"][key]
            _, entry_rates, _ = resolve_model(message.get("model"), self.rates)
            uncached = uncached_cost(
                tokens, entry_rates, self.rates, date,
                usage.get("speed"), usage.get("service_tier"),
            )
            self.uncached += uncached

        # Lane: the file's position in the tree, corrected by the turn's own
        # isSidechain flag when a main-thread file carries sidechain entries.
        lane = file_lane
        if lane == "main" and entry.get("isSidechain"):
            lane = "subagent"

        values = {
            "model": priced["canonical"] or "(no model)",
            "project": project,
            "skill": entry.get("attributionSkill") or "(none)",
            "effort": entry.get("effort") or "(unset)",
            "branch": entry.get("gitBranch") or "(none)",
            "lane": lane,
            "tier": priced["tier"] or "(unset)",
            "version": entry.get("version") or "(unknown)",
        }
        # The rate key is everything besides the token counts that changes what a
        # turn costs. Anything not in it (the date, for a dated price change) is a
        # stated limit of repricing, not a silent one: see the Method section.
        speed = usage.get("speed") or "standard"
        tier_name = priced["tier"] or "standard"
        rate_key = values["model"]
        if speed != "standard":
            rate_key += f"#{speed}"
        if tier_name != "standard":
            rate_key += f"@{tier_name}"
        self.rate_keys.setdefault(rate_key, {
            "model": values["model"],
            "speed": speed,
            "tier": tier_name,
            "status": priced["status"],
        })

        for name, value in values.items():
            self.dims[name][value].add(priced, uncached)
            add_tokens(self.dim_rates[name][value][rate_key], tokens)

        if date:
            self.days[date][values["model"]].add(priced, uncached)
            self.day_tot[date].add(priced, uncached)
            slot = self.day_dims[date]
            unpriced_here = 1 if priced["status"] == UNPRICED else 0
            for name, value in values.items():
                if name == "model":
                    continue  # by_model already carries the day's model slice in full
                cell = slot[name][value]
                cell[0] += 1
                cell[1] += priced["cost"]["total"]
                cell[2] += unpriced_here

        session_id = entry.get("sessionId") or entry.get("session_id")
        if session_id:
            sess = self.sessions.get(session_id)
            if sess is None:
                sess = self.sessions[session_id] = {
                    "id": session_id, "project": project, "lane": lane,
                    "started": entry.get("timestamp"), "ended": entry.get("timestamp"),
                    "turns": 0, "cost": 0.0, "uncached": 0.0,
                    "models": set(), "title": None, "unpriced_turns": 0,
                }
            sess["turns"] += 1
            sess["cost"] += priced["cost"]["total"]
            sess["uncached"] += uncached
            sess["models"].add(values["model"])
            if priced["status"] == UNPRICED:
                sess["unpriced_turns"] += 1
            ts = entry.get("timestamp")
            if ts:
                if not sess["started"] or ts < sess["started"]:
                    sess["started"] = ts
                if not sess["ended"] or ts > sess["ended"]:
                    sess["ended"] = ts

        if priced["status"] != UNPRICED:
            sample = self.calib[values["model"]][values["effort"]]
            sample["input"].append(tokens["input"])
            sample["output"].append(tokens["output"])
            sample["cache_read"].append(tokens["cache_read"])
            sample["cache_write"].append(tokens["cache_write_5m"] + tokens["cache_write_1h"])

    def collect_titles(self, root):
        """Session titles come from custom-title / ai-title entries, which are
        not assistant turns. Only read when the output keeps them."""
        for path, _ in find_transcripts(root, include_subagents=False):
            try:
                with open(path, encoding="utf-8", errors="replace") as fh:
                    for line in fh:
                        if '"title"' not in line and '"customTitle"' not in line:
                            continue
                        try:
                            entry = json.loads(line)
                        except (ValueError, TypeError):
                            continue
                        sid = entry.get("sessionId") or entry.get("session_id")
                        sess = self.sessions.get(sid) if sid else None
                        if not sess:
                            continue
                        title = (
                            entry.get("customTitle") or entry.get("aiTitle")
                            or entry.get("title")
                        )
                        if isinstance(title, str) and title.strip():
                            sess["title"] = title.strip()[:120]
            except OSError:
                continue

    # -- output ---------------------------------------------------------

    def anon(self, value):
        digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:4]
        return f"proj-{digest}"

    def to_json(self):
        a = self.args.anonymize
        cost = {k: round(v, 6) for k, v in self.cost.items()}

        dims = {}
        for name, buckets in self.dims.items():
            if a and name in ("branch",):
                continue  # a branch name leaks work in progress
            rows = []
            for key, bucket in buckets.items():
                label = self.anon(key) if (a and name == "project") else key
                row = bucket.as_dict(label)
                row["by_rate"] = {
                    rk: dict(tk)
                    for rk, tk in sorted(self.dim_rates[name][key].items())
                }
                rows.append(row)
            rows.sort(key=lambda r: r["cost"]["total"], reverse=True)
            dims[name] = rows

        days = []
        for date in sorted(self.days):
            day = {"date": date}
            day.update(self.day_tot[date].as_dict())
            day["by_model"] = {
                model: bucket.as_dict()
                for model, bucket in sorted(self.days[date].items())
            }
            day["dims"] = {}
            for name, keys in self.day_dims[date].items():
                if a and name == "branch":
                    continue
                cells = {}
                for key, cell in sorted(keys.items(), key=lambda kv: -kv[1][1]):
                    label = self.anon(key) if (a and name == "project") else key
                    cells[label] = [cell[0], round(cell[1], 6), cell[2]]
                day["dims"][name] = cells
            days.append(day)

        sessions = []
        for sess in sorted(self.sessions.values(), key=lambda s: -s["cost"]):
            row = {
                "id": self.anon(sess["id"]) if a else sess["id"],
                "project": self.anon(sess["project"]) if a else sess["project"],
                "lane": sess["lane"],
                "started": sess["started"],
                "ended": sess["ended"],
                "turns": sess["turns"],
                "cost": round(sess["cost"], 6),
                "uncached_cost": round(sess["uncached"], 6),
                "models": sorted(sess["models"]),
                "unpriced_turns": sess["unpriced_turns"],
            }
            if sess["title"] and not a:
                row["title"] = sess["title"]
            sessions.append(row)

        calibration = {}
        for model, by_effort in self.calib.items():
            calibration[model] = {}
            for effort, sample in by_effort.items():
                calibration[model][effort] = {
                    "turns": len(sample["input"]),
                    "input_p50": percentile(sample["input"], 50),
                    "output_p50": percentile(sample["output"], 50),
                    "cache_read_p50": percentile(sample["cache_read"], 50),
                    "cache_write_p50": percentile(sample["cache_write"], 50),
                    "output_p90": percentile(sample["output"], 90),
                }

        turn_counts = [s["turns"] for s in self.sessions.values()]
        cached_in = self.tokens["cache_read"]
        total_in = (
            cached_in + self.tokens["input"]
            + self.tokens["cache_write_5m"] + self.tokens["cache_write_1h"]
        )

        window_days = None
        if self.first_date and self.last_date:
            d0 = datetime.strptime(self.first_date, "%Y-%m-%d")
            d1 = datetime.strptime(self.last_date, "%Y-%m-%d")
            window_days = (d1 - d0).days + 1

        return {
            "schema": SCHEMA,
            "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "generator": f"{GENERATOR} (https://releve.neorgon.com)",
            "anonymized": bool(a),
            # Named so a reader can tell "no branches in this window" from
            # "branch names were withheld". An empty dimension is ambiguous.
            "withheld": ["branch", "session_title", "project_path"] if a else [],
            "rates": {
                "version": self.rates.get("version"),
                "verified": self.rates.get("verified"),
                "source": self.rates.get("source"),
            },
            "window": {
                "from": self.first_date,
                "to": self.last_date,
                "days": window_days,
                "requested_from": self.args.since,
                "requested_until": self.args.until,
            },
            "plan": {
                "monthly_cost": self.args.plan_cost,
                "note": "What the subscription actually costs, for the multiple. Not derived from tokens.",
            },
            "totals": {
                "sessions": len(self.sessions),
                "turns": self.turns,
                "files": self.files_read,
                "tokens": dict(self.tokens),
                "cost": cost,
                "counterfactual": {
                    "no_cache_total": round(self.uncached, 6),
                    "cache_saved": round(self.uncached - cost["total"], 6),
                    "note": "Every cache read and cache write repriced as fresh input at the same model and rate.",
                },
                "unpriced": {
                    "turns": self.unpriced_turns,
                    "models": [
                        {"model": m, "turns": n}
                        for m, n in sorted(self.unpriced_models.items(), key=lambda kv: -kv[1])
                    ],
                    "tokens": dict(self.unpriced_tokens),
                    "note": "No rate published in the rate card. Counted, never priced, never zeroed.",
                },
                "excluded": {
                    "turns": self.excluded_turns,
                    "models": [
                        {"model": m, "turns": n}
                        for m, n in sorted(self.excluded_models.items(), key=lambda kv: -kv[1])
                    ],
                    "note": "Generated locally without an API call. Never billed.",
                },
                "quality": {
                    "estimated_cache_split_turns": self.estimated_split_turns,
                    "tier_assumed_turns": self.tier_assumed_turns,
                    "iteration_turns": self.iteration_turns,
                    "multi_iteration_turns": self.multi_iteration_turns,
                    "duplicate_turns_skipped": self.duplicate_turns,
                    "richer_duplicates_preferred": self.richer_duplicates,
                    "malformed_lines": self.malformed_lines,
                    "files_unreadable": self.files_skipped,
                },
            },
            "days": days,
            "dimensions": dims,
            # What each by_rate key means. A bucket's cost is the sum over its
            # rate keys of tokens priced under that key, so the site can rebuild
            # any total from tokens and a rate card alone.
            "rate_keys": self.rate_keys,
            "sessions": sessions,
            "calibration": {
                "tokens_per_turn": calibration,
                "turns_per_session": {
                    "p50": percentile(turn_counts, 50),
                    "p90": percentile(turn_counts, 90),
                    "mean": round(sum(turn_counts) / len(turn_counts), 2) if turn_counts else None,
                },
                "cache_hit_ratio": round(cached_in / total_in, 6) if total_in else None,
            },
        }


# --------------------------------------------------------------------------
# Reports
# --------------------------------------------------------------------------

def money(value):
    return f"${value:,.2f}"


def big(value):
    if value >= 1_000_000_000:
        return f"{value / 1_000_000_000:.2f}B"
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f}M"
    if value >= 1_000:
        return f"{value / 1_000:.1f}k"
    return str(value)


def bar(fraction, width=22):
    filled = int(round(max(0.0, min(1.0, fraction)) * width))
    return "#" * filled + "." * (width - filled)


def print_report(doc, rates_provenance, top=8):
    t = doc["totals"]
    w = doc["window"]
    cost = t["cost"]

    print()
    print("=" * 68)
    span = f"{w['from']} to {w['to']}" if w["from"] else "no turns in window"
    print(f"  RELEVE  ·  {span}  ·  {w['days'] or 0} days")
    print("=" * 68)
    print(f"  {t['sessions']:,} sessions · {t['turns']:,} turns · {t['files']:,} transcripts")
    print()
    print(f"  API-equivalent        {money(cost['total']):>14}")
    print(f"    input               {money(cost['input']):>14}   {big(t['tokens']['input']):>9} tok")
    print(f"    output              {money(cost['output']):>14}   {big(t['tokens']['output']):>9} tok")
    write = t["tokens"]["cache_write_5m"] + t["tokens"]["cache_write_1h"]
    print(f"    cache write         {money(cost['cache_write']):>14}   {big(write):>9} tok")
    print(f"    cache read          {money(cost['cache_read']):>14}   {big(t['tokens']['cache_read']):>9} tok")
    print()

    plan = doc["plan"]["monthly_cost"]
    if plan and w["days"]:
        plan_total = plan * (w["days"] / 30.44)
        print(f"  Plan cost             {money(plan_total):>14}   "
              f"{money(plan)}/mo pro-rated over {w['days']} days")
        if plan_total > 0:
            print(f"  Multiple              {cost['total'] / plan_total:>13.1f}x   "
                  f"API-equivalent per dollar of subscription")
        print()

    cf = t["counterfactual"]
    if cf["no_cache_total"] > 0:
        ratio = cf["no_cache_total"] / cost["total"] if cost["total"] else 0
        print(f"  Without any cache     {money(cf['no_cache_total']):>14}   "
              f"{ratio:.1f}x what you paid")
        print(f"  Cache saved           {money(cf['cache_saved']):>14}")
        hit = doc["calibration"]["cache_hit_ratio"]
        if hit is not None:
            print(f"  Cache hit ratio       {hit * 100:>13.1f}%   of all input tokens were reads")
        print()

    if t["unpriced"]["turns"]:
        models = ", ".join(f"{m['model']} ({m['turns']:,})" for m in t["unpriced"]["models"])
        tok = sum(t["unpriced"]["tokens"].values())
        print(f"  UNPRICED  {t['unpriced']['turns']:,} turns, {big(tok)} tokens: {models}")
        print("            No published rate, so not included above. Unknown is not zero.")
        print()
    if t["excluded"]["turns"]:
        models = ", ".join(m["model"] for m in t["excluded"]["models"])
        print(f"  EXCLUDED  {t['excluded']['turns']:,} turns ({models}), never billed")
        print()

    for name, heading in (("model", "By model"), ("project", "By project"),
                          ("skill", "By skill"), ("lane", "By lane"),
                          ("effort", "By effort")):
        rows = doc["dimensions"].get(name) or []
        if not rows:
            continue
        top_cost = rows[0]["cost"]["total"] or 1
        print(f"  {heading}")
        for row in rows[:top]:
            label = str(row["key"])[:30]
            # A row whose every turn is unpriced has no dollar figure at all.
            # Printing $0.00 there would read as "this model was free".
            if row["unpriced_turns"] == row["turns"]:
                print(f"    {label:<30} {'unpriced':>12}  {'':5}   "
                      f"{'.' * 22}  {row['turns']:,} turns")
                continue
            share = row["cost"]["total"] / cost["total"] if cost["total"] else 0
            suffix = ""
            if row["unpriced_turns"]:
                suffix = f"  (+{row['unpriced_turns']:,} unpriced)"
            print(f"    {label:<30} {money(row['cost']['total']):>12}  {share * 100:5.1f}%  "
                  f"{bar(row['cost']['total'] / top_cost)}  {row['turns'] - row['unpriced_turns']:,} turns{suffix}")
        if len(rows) > top:
            tail = rows[top:]
            rest = sum(r["cost"]["total"] for r in tail)
            rest_unpriced = sum(r["unpriced_turns"] for r in tail)
            label = f"+ {len(tail)} more"
            if rest_unpriced and rest == 0:
                # Every remaining row is unpriced. Say so instead of showing $0.00.
                print(f"    {label:<30} {'unpriced':>12}")
            elif rest_unpriced:
                print(f"    {label:<30} {money(rest):>12}"
                      f"{'':13}{'':24}  (+{rest_unpriced:,} unpriced)")
            else:
                print(f"    {label:<30} {money(rest):>12}")
        print()

    q = t["quality"]
    notes = []
    if q["estimated_cache_split_turns"]:
        notes.append(f"{q['estimated_cache_split_turns']:,} turns had no cache TTL split "
                     "(priced as 5-minute, so cache write may be understated)")
    if q["tier_assumed_turns"]:
        notes.append(f"{q['tier_assumed_turns']:,} turns used a service tier with no published "
                     "multiple (priced at standard, so the total is a floor)")
    if q["duplicate_turns_skipped"]:
        note = (f"{q['duplicate_turns_skipped']:,} repeated entries collapsed to one billed "
                "turn each (a response is written one entry per content block, all "
                "repeating the same usage; resuming a session replays it again)")
        if q["richer_duplicates_preferred"]:
            note += (f", of which {q['richer_duplicates_preferred']:,} later copies were more "
                     "complete than the first and were used instead")
        notes.append(note)
    if q["multi_iteration_turns"]:
        notes.append(f"{q['multi_iteration_turns']:,} turns ran multiple iterations, where the "
                     "top-level counters hold only the last one. Priced from the sum")
    if q["malformed_lines"]:
        notes.append(f"{q['malformed_lines']:,} unparseable lines skipped")
    if q["files_unreadable"]:
        notes.append(f"{q['files_unreadable']:,} files could not be read")
    if notes:
        print("  Caveats")
        for note in notes:
            print(f"    - {note}")
        print()

    print(f"  rates {doc['rates']['version']} as of {doc['rates']['verified']}  ·  {rates_provenance}")
    print("  API-equivalent is a counterfactual at list rates, not an invoice.")
    print()


def write_csv(doc, path):
    import csv
    rows = []
    for day in doc["days"]:
        for model, bucket in day["by_model"].items():
            rows.append({
                "date": day["date"], "model": model, "turns": bucket["turns"],
                **{f"tok_{k}": v for k, v in bucket["tokens"].items()},
                **{f"cost_{k}": round(v, 6) for k, v in bucket["cost"].items()},
                "uncached_cost": bucket["uncached_cost"],
            })
    if not rows:
        rows = [{"date": "", "model": "", "turns": 0}]
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)


def notify(title, message):
    """Best-effort desktop notification. Silent when unavailable."""
    try:
        if platform.system() == "Darwin":
            body = message.replace('"', "'")
            head = title.replace('"', "'")
            subprocess.run(
                ["osascript", "-e", f'display notification "{body}" with title "{head}"'],
                check=False, capture_output=True, timeout=5,
            )
        elif platform.system() == "Linux":
            subprocess.run(["notify-send", title, message], check=False,
                           capture_output=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        pass


# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Price your Claude Code transcripts. Emits releve.json for "
                    "https://releve.neorgon.com",
        epilog="Nothing in the output contains prompt or response text.",
    )
    ap.add_argument("--root", default=DEFAULT_ROOT, help=f"transcript root (default {DEFAULT_ROOT})")
    ap.add_argument("--days", type=int, help="only the last N days, inclusive of today")
    ap.add_argument("--since", metavar="YYYY-MM-DD", help="earliest turn to count")
    ap.add_argument("--until", metavar="YYYY-MM-DD", help="latest turn to count")
    ap.add_argument("--out", metavar="PATH", help="write releve.json here")
    ap.add_argument("--format", choices=("text", "json", "csv"), default="text",
                    help="stdout format (default text; --out always writes JSON unless --format csv)")
    ap.add_argument("--anonymize", action="store_true",
                    help="hash project and session ids, drop paths, branches and titles")
    ap.add_argument("--no-subagents", action="store_true",
                    help="main thread only, ignoring subagent and workflow transcripts")
    ap.add_argument("--plan-cost", type=float, default=100.0, metavar="USD",
                    help="what the subscription costs per month (default 100, Max 5x)")
    ap.add_argument("--budget", type=float, metavar="USD",
                    help="exit 1 if API-equivalent cost exceeds this")
    ap.add_argument("--notify", action="store_true", help="desktop notification with the total")
    ap.add_argument("--rates", metavar="PATH|URL", help="rate card to use")
    ap.add_argument("--rates-refresh", action="store_true",
                    help="fetch the current rate card from releve.neorgon.com")
    ap.add_argument("--top", type=int, default=8, help="rows per breakdown in the text report")
    ap.add_argument("--quiet", action="store_true",
                    help="suppress progress, and the report too when --out is given")
    args = ap.parse_args()

    args.since, args.until = resolve_window(args)

    root = os.path.abspath(os.path.expanduser(args.root))
    if not os.path.isdir(root):
        print(f"error: no transcript directory at {root}", file=sys.stderr)
        return 2

    rates, provenance = load_rates(args.rates, args.rates_refresh)

    files = find_transcripts(root, include_subagents=not args.no_subagents)
    if not files:
        print(f"error: no .jsonl transcripts under {root}", file=sys.stderr)
        return 2

    scan = Scan(rates, args)
    started = time.time()
    show = not args.quiet and args.format == "text"
    for pass_no in (1, 2):
        for i, (path, lane) in enumerate(files, 1):
            if show and (i % 25 == 0 or i == len(files)):
                print(f"\r  pass {pass_no}/2  {i}/{len(files)} transcripts...",
                      end="", file=sys.stderr)
            scan.read_file(path, lane, pass_no)
    if show:
        print(f"\r  read {len(files)} transcripts in {time.time() - started:.1f}s"
              f"{' ' * 24}", file=sys.stderr)

    if not args.anonymize:
        scan.collect_titles(root)

    doc = scan.to_json()

    if args.out:
        if args.format == "csv":
            count = write_csv(doc, args.out)
            if not args.quiet:
                print(f"  wrote {count:,} rows to {args.out}", file=sys.stderr)
        else:
            with open(args.out, "w", encoding="utf-8") as fh:
                json.dump(doc, fh, indent=2)
            if not args.quiet:
                size = os.path.getsize(args.out) / 1024
                print(f"  wrote {args.out} ({size:,.0f} KB)", file=sys.stderr)

    if args.format == "json":
        json.dump(doc, sys.stdout, indent=2)
        print()
    elif args.format == "csv" and not args.out:
        import csv
        writer = csv.writer(sys.stdout)
        writer.writerow(["date", "model", "turns", "cost_total"])
        for day in doc["days"]:
            for model, bucket in day["by_model"].items():
                writer.writerow([day["date"], model, bucket["turns"], bucket["cost"]["total"]])
    elif not (args.quiet and args.out):
        # --quiet with --out is the scripted case: the data is in the file, so
        # there is nothing to lose by staying silent. Without --out, printing the
        # report is the only output there is, so --quiet only drops the progress.
        print_report(doc, provenance, top=args.top)

    total = doc["totals"]["cost"]["total"]
    if args.notify:
        notify("Releve", f"{money(total)} API-equivalent over {doc['window']['days'] or 0} days")

    if args.budget is not None and total > args.budget:
        print(f"  over budget: {money(total)} > {money(args.budget)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
