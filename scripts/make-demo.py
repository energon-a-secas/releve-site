#!/usr/bin/env python3
"""Build data/demo.json: the dataset the public site loads.

Dev tool, not visitor-facing. It writes a synthetic transcript tree to a temp
directory and then runs releve-scan.py over it, so the demo file is produced by
the same scanner a visitor downloads. The schema cannot drift from the real one,
and generating it is an end-to-end exercise of the scanner.

    python3 scripts/make-demo.py                 # writes data/demo.json
    python3 scripts/make-demo.py --keep /tmp/fake  # leave the tree for inspection

Nothing real is published. The shape constants below are aggregate ratios read
off one 30-day scan of the author's own machine (model mix, effort mix, cache
hit ratio, session length quartiles). Project names, branch names, session
titles and every token count are invented. Seeded, so the same seed rebuilds
the same file and a diff is reviewable.

Two deliberate departures from the measured shape, both so the site's own
quality caveats have something to display: a slice of turns carries a flat
cache_creation_input_tokens with no TTL split (estimated_cache_split), and a
slice carries service_tier: "priority" (tier_assumed). On the real machine both
are zero.
"""

import argparse
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCANNER = os.path.join(HERE, "releve-scan.py")
OUT = os.path.join(ROOT, "data", "demo.json")

# -- measured shape, as ratios ---------------------------------------------

MODELS = [
    ("claude-opus-5", 0.62),
    ("claude-fable-5", 0.14),
    ("claude-opus-4-8", 0.07),
    ("claude-sonnet-5", 0.06),
    ("claude-haiku-4-5", 0.05),
    ("kimi-k3", 0.05),          # unpriced, so the bucket is never empty
    ("<synthetic>", 0.01),      # excluded, likewise
]
EFFORTS = [("xhigh", 0.60), ("high", 0.30), ("max", 0.10)]
LANES = [("main", 0.73), ("subagent", 0.24), ("workflow", 0.03)]
SKILLS = [
    ("(none)", 0.62), ("task", 0.24), ("review", 0.04), ("new-project", 0.03),
    ("writeup", 0.02), ("migrate", 0.02), ("changelog", 0.02), ("audit", 0.01),
]
VERSIONS = [("2.1.248", 0.7), ("2.1.240", 0.2), ("2.1.199", 0.1)]

WRITE_1H_SHARE = 0.67     # share of cache writes taken at the 1-hour TTL
THINKING_SHARE = 0.21     # share of output tokens that were reasoning
ITERATION_SHARE = 0.63    # turns whose usage carries an iterations array
NO_SPLIT_SHARE = 0.02     # turns with a flat cache_creation counter, no TTL split
PRIORITY_SHARE = 0.01     # turns on a service tier with no published multiple
FAST_SHARE = 0.02         # turns at speed: "fast" (Opus only)
BIG_WRITE_SHARE = 0.015   # turns that write a fresh context block, not a delta
BIG_WRITE_MEDIAN = 160_000

# On the measured corpus fresh input is a rounding error: the p50 is 2 tokens,
# because everything but the delta is served from cache. The 97.5% hit ratio
# comes out of the read-to-write ratio, not out of fresh input, so drawing input
# from the hit ratio (the obvious thing) overstates it by four orders of
# magnitude. Draw it small and let the ratio emerge.
INPUT_MEDIAN = 2

# Per-model, per-effort medians. Output and cache read are drawn around these.
PROFILE = {
    "claude-opus-5":     {"output": 430, "read": 200_000, "write": 1_100},
    "claude-fable-5":    {"output": 600, "read": 230_000, "write": 1_900},
    "claude-opus-4-8":   {"output": 500, "read": 260_000, "write": 1_100},
    "claude-sonnet-5":   {"output": 240, "read": 100_000, "write": 2_400},
    "claude-haiku-4-5":  {"output": 180, "read": 40_000, "write": 900},
    "kimi-k3":           {"output": 850, "read": 100_000, "write": 0},
    "<synthetic>":       {"output": 60, "read": 0, "write": 0},
}
EFFORT_SCALE = {"high": 0.85, "xhigh": 1.0, "max": 1.6}

# Invented, and deliberately unlike anything in the fleet.
PROJECTS = [
    "work/atlas-api", "work/atlas-web", "work/ledger-service", "work/ingest-pipeline",
    "work/design-system", "side/recipe-box", "side/tide-clock", "side/chord-trainer",
    "notes/reading-log", "sandbox/wasm-spike",
]
BRANCHES = [
    "main", "feat/streaming-parser", "feat/dark-mode", "fix/timezone-drift",
    "chore/deps-august", "spike/wasm", "release/2.4",
]
TITLES = [
    "Streaming parser for the ingest pipeline", "Dark mode across the design system",
    "Timezone drift in the ledger export", "August dependency bump",
    "WASM spike: is it worth it", "Recipe box offline mode",
    "Chord trainer ear-training mode", "Reading log tag cleanup",
    "Atlas API pagination rewrite", "Release 2.4 checklist",
]


def pick(rng, weighted):
    """Weighted choice from [(value, weight), ...]."""
    total = sum(w for _, w in weighted)
    point = rng.random() * total
    for value, weight in weighted:
        point -= weight
        if point <= 0:
            return value
    return weighted[-1][0]


def around(rng, median, spread=0.55):
    """A lognormal-ish draw around median. Long right tail, never negative."""
    if median <= 0:
        return 0
    return max(0, int(median * rng.lognormvariate(0, spread)))


def make_usage(rng, model, effort):
    """One synthetic usage object, in the shape the real transcripts use."""
    profile = PROFILE[model]
    scale = EFFORT_SCALE[effort]

    output = around(rng, profile["output"] * scale)
    read = around(rng, profile["read"] * scale)
    write = around(rng, profile["write"] * scale)
    if profile["write"] and rng.random() < BIG_WRITE_SHARE:
        write += around(rng, BIG_WRITE_MEDIAN, 0.4)
    fresh = around(rng, INPUT_MEDIAN, 1.4)
    if model == "<synthetic>":
        read = write = fresh = 0

    usage = {
        "input_tokens": fresh,
        "output_tokens": output,
        "cache_read_input_tokens": read,
        "cache_creation_input_tokens": write,
        "service_tier": "priority" if rng.random() < PRIORITY_SHARE else "standard",
        "speed": "fast" if (model.startswith("claude-opus") and rng.random() < FAST_SHARE)
                 else "standard",
        "inference_geo": "not_available",
    }
    if output:
        usage["output_tokens_details"] = {"thinking_tokens": int(output * THINKING_SHARE)}

    if write and rng.random() >= NO_SPLIT_SHARE:
        one_hour = int(write * WRITE_1H_SHARE)
        usage["cache_creation"] = {
            "ephemeral_1h_input_tokens": one_hour,
            "ephemeral_5m_input_tokens": write - one_hour,
        }
    # Else: only the flat counter, which the engine prices as 5m and flags.

    if rng.random() < ITERATION_SHARE:
        # One iteration mirroring the top level, which is what all but a handful
        # of real turns look like. The engine sums the array and uses it in place
        # of the top-level counters, so a mirror changes nothing.
        it = {
            "input_tokens": usage["input_tokens"],
            "output_tokens": usage["output_tokens"],
            "cache_read_input_tokens": usage["cache_read_input_tokens"],
            "cache_creation_input_tokens": usage["cache_creation_input_tokens"],
            "type": "message",
        }
        if "cache_creation" in usage:
            it["cache_creation"] = dict(usage["cache_creation"])
        usage["iterations"] = [it]

    return usage


def session_turns(rng):
    """Responses per session. Fitted to the measured distribution: p25 81,
    p50 211, p75 498, p90 781, longest 6,757."""
    return max(1, min(7_000, int(rng.lognormvariate(5.14, 1.47))))


# How many JSONL entries one response is written as. Claude Code writes one per
# content block and repeats the same usage object on each, so a turn that
# thought, spoke and called two tools lands four times. Measured over 52,078 real
# responses; a generator that emitted one entry each would never exercise the
# dedup rule the whole bill depends on.
BLOCKS_PER_RESPONSE = [
    (1, 16805), (2, 17539), (3, 12478), (4, 2662), (5, 398),
    (6, 1729), (7, 81), (8, 159), (9, 146), (10, 40), (12, 26),
]

# Share of the extra copies that carry a zeroed output counter, the way a real
# thinking-block entry does. These are the copies the richest-copy pass has to
# discard in favour of the fuller one.
PARTIAL_COPY_SHARE = 0.45


def dir_name(project, home):
    """The directory name Claude Code would use for a cwd: every non-alphanumeric
    run collapsed to a dash."""
    path = f"{home}/{project}"
    out = []
    for ch in path:
        out.append(ch if ch.isalnum() else "-")
    return "".join(out)


def fake_uuid(rng):
    """A uuid4-shaped id drawn from the seeded rng. uuid.uuid4() reads os.urandom
    and so ignores --seed: it is why two seeded runs used to disagree on every
    session id, and, through the accumulation order that follows from it, on the
    last digit of a few hundred cost fields."""
    h = f"{rng.randrange(16 ** 32):032x}"
    variant = "89ab"[rng.randrange(4)]
    return f"{h[:8]}-{h[8:12]}-4{h[13:16]}-{variant}{h[17:20]}-{h[20:32]}"


def build_tree(rng, root, days, sessions, home, end=None):
    """Write a synthetic three-tier transcript tree. Returns the turn count."""
    end = end or datetime.now(timezone.utc).replace(microsecond=0)
    start = end - timedelta(days=days - 1)
    turns = 0

    for _ in range(sessions):
        project = rng.choice(PROJECTS)
        branch = rng.choice(BRANCHES)
        version = pick(rng, VERSIONS)
        cwd = f"{home}/{project}"
        session_id = fake_uuid(rng)
        proj_dir = os.path.join(root, dir_name(project, home))
        os.makedirs(proj_dir, exist_ok=True)

        count = session_turns(rng)
        began = start + timedelta(seconds=rng.random() * (days - 1) * 86_400)
        # Sessions are bursty: a few minutes between turns, occasionally hours.
        clock = began

        # Split the session across the three tiers the way the real tree does.
        buckets = {"main": [], "subagent": [], "workflow": []}
        for _ in range(count):
            buckets[pick(rng, LANES)].append(None)

        for lane, slots in buckets.items():
            if not slots:
                continue
            if lane == "main":
                path = os.path.join(proj_dir, f"{session_id}.jsonl")
            elif lane == "subagent":
                path = os.path.join(proj_dir, session_id, "subagents",
                                    f"agent-{rng.randrange(16**8):08x}.jsonl")
            else:
                path = os.path.join(proj_dir, session_id, "subagents", "workflows",
                                    f"wf_{rng.randrange(16**8):08x}",
                                    f"agent-{rng.randrange(16**8):08x}.jsonl")
            os.makedirs(os.path.dirname(path), exist_ok=True)

            with open(path, "w", encoding="utf-8") as fh:
                # The first line carries cwd, which is how the scanner labels a
                # project. Real transcripts put it on every entry.
                for _ in slots:
                    model = pick(rng, MODELS)
                    effort = pick(rng, EFFORTS)
                    clock += timedelta(seconds=rng.expovariate(1 / 90.0))
                    if clock > end:
                        clock = end
                    entry = {
                        "type": "assistant",
                        "uuid": fake_uuid(rng),
                        "sessionId": session_id,
                        "timestamp": clock.isoformat().replace("+00:00", "Z"),
                        "cwd": cwd,
                        "gitBranch": branch,
                        "version": version,
                        "effort": effort,
                        "attributionSkill": None if lane == "main" and rng.random() < 0.7
                                            else pick(rng, SKILLS),
                        "isSidechain": lane != "main",
                        "message": {
                            "id": f"msg_{rng.randrange(16**12):012x}",
                            "role": "assistant",
                            "model": model,
                            "usage": make_usage(rng, model, effort),
                        },
                    }
                    if entry["attributionSkill"] == "(none)":
                        entry["attributionSkill"] = None

                    # One response, written once per content block. Every copy
                    # shares message.id and repeats the usage; a share of the
                    # earlier ones report no output yet. The scanner has to
                    # collapse them to one billed turn.
                    copies = pick(rng, BLOCKS_PER_RESPONSE)
                    for index in range(copies):
                        copy = dict(entry)
                        copy["uuid"] = fake_uuid(rng)
                        if index < copies - 1 and rng.random() < PARTIAL_COPY_SHARE:
                            usage = dict(entry["message"]["usage"])
                            usage["output_tokens"] = 0
                            usage.pop("output_tokens_details", None)
                            usage.pop("iterations", None)
                            copy["message"] = dict(entry["message"], usage=usage)
                        fh.write(json.dumps(copy) + "\n")
                    turns += 1

        # A title entry, so the demo exercises the session-title path.
        with open(os.path.join(proj_dir, f"{session_id}.jsonl"), "a", encoding="utf-8") as fh:
            fh.write(json.dumps({
                "type": "summary", "sessionId": session_id,
                "customTitle": rng.choice(TITLES),
            }) + "\n")

    return turns


def main():
    ap = argparse.ArgumentParser(description="Generate the site's synthetic demo dataset")
    ap.add_argument("--seed", type=int, default=20260827, help="deterministic seed")
    ap.add_argument("--days", type=int, default=90, help="window to span")
    # 4.3 sessions a day, the measured rate, so the demo's per-day intensity is
    # realistic over a longer window rather than a real month stretched over three.
    ap.add_argument("--sessions", type=int, default=390)
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--keep", help="write the transcript tree here and leave it")
    # --seed alone does not make a run reproducible: the window ends at "now", so
    # every date in the output shifts by a day overnight and the totals are the
    # only stable part. Default to now anyway, because a demo dataset dated last
    # spring reads as abandoned; pass --end to pin it and get byte-identical output.
    ap.add_argument("--end", help="anchor the window's last day, YYYY-MM-DD (default: today)")
    args = ap.parse_args()

    end = None
    if args.end:
        end = datetime.strptime(args.end, "%Y-%m-%d").replace(tzinfo=timezone.utc)

    rng = random.Random(args.seed)
    # The scanner labels a project by its cwd relative to $HOME, so the tree has
    # to be rooted at the real one for the labels to come out as "work/atlas-api"
    # rather than an absolute path. The tree lives in a temp directory and is
    # deleted; only the relative label reaches demo.json. Verified by the grep in
    # the site's Makefile target.
    home = os.path.expanduser("~").rstrip(os.sep)

    tmp = args.keep or tempfile.mkdtemp(prefix="releve-demo-")
    tree = os.path.join(tmp, "projects")
    os.makedirs(tree, exist_ok=True)
    try:
        turns = build_tree(rng, tree, args.days, args.sessions, home, end)
        print(f"  generated {turns:,} synthetic turns across {args.sessions} sessions")

        result = subprocess.run(
            [sys.executable, SCANNER, "--root", tree, "--days", str(args.days),
             "--out", args.out, "--quiet"],
            check=True, capture_output=True, text=True,
        )
        if result.stderr.strip():
            print(result.stderr.rstrip())

        with open(args.out, encoding="utf-8") as fh:
            doc = json.load(fh)
        # The one field the scanner cannot know. The site reads it to badge the
        # dataset, so a visitor is never shown invented numbers unlabelled.
        doc["synthetic"] = True
        doc["generator"] = f"make-demo.py seed={args.seed} via releve-scan.py"
        doc["synthetic_note"] = (
            "Invented data shaped like one real 30-day scan: model mix, effort mix, "
            "cache hit ratio and session lengths match, every token count and every "
            "name does not. Run the scripts on your own machine for real numbers."
        )
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=2)

        size = os.path.getsize(args.out) / 1024
        t = doc["totals"]
        print(f"  wrote {os.path.relpath(args.out, ROOT)} ({size:,.0f} KB)")
        print(f"  {t['sessions']} sessions · {t['turns']:,} turns · "
              f"${t['cost']['total']:,.2f} API-equivalent")
        q = t["quality"]
        print(f"  exercises: {t['unpriced']['turns']:,} unpriced · "
              f"{t['excluded']['turns']:,} excluded · "
              f"{q['estimated_cache_split_turns']:,} no TTL split · "
              f"{q['tier_assumed_turns']:,} assumed tier")
    finally:
        if not args.keep:
            shutil.rmtree(tmp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
