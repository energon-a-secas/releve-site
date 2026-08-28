#!/usr/bin/env python3
"""Releve repo: what a codebase costs to show a model, and what a stretch of
work on it will cost.

    curl -O https://releve.neorgon.com/scripts/releve-repo.py
    curl -O https://releve.neorgon.com/scripts/releve_cost.py
    curl -O https://releve.neorgon.com/data/tokenizer.json

    python3 releve-repo.py .                              # count and price this tree
    python3 releve-repo.py . --out releve-repo.json       # feed section 5 of the site
    python3 releve-repo.py . --tokenizer api              # exact, needs ANTHROPIC_API_KEY
    python3 releve-repo.py --calibrate                    # remeasure the factors here
    python3 releve-repo.py . --project --iterations 40    # forecast, from your history

Two jobs, because they answer the same question at two scales: what is in front
of the model once, and what happens when the work runs forty times.

THE TOKENIZER, WHICH IS THE WHOLE ACCURACY STORY

`tiktoken` is an OpenAI tokenizer. Running it on code and calling the result a
Claude token count is the central defect of every repo-token tool this one was
compared against, and it is not a small one: the vocabularies differ. So there
are three modes here and each states what it is.

  calibrated  (default)  characters divided by a per-language factor measured
              from real transcripts. An assistant response is written to the
              transcript as one entry per content block, all sharing a
              message.id, so reassembling those blocks recovers exactly the
              characters that the response's output_tokens paid for. That is a
              labelled training pair, tens of thousands of them, free and
              offline. Shipped factors are in data/tokenizer.json with the
              measured spread beside them; --calibrate replaces them with your
              own machine's.
  api         exact. Sends each file to /v1/messages/count_tokens, which is the
              only way to know. Needs ANTHROPIC_API_KEY, costs nothing per call,
              and is rate limited, so it is opt-in rather than the default.
  chars       one flat divisor for everything. The crude baseline, kept so the
              value of calibrating is visible rather than asserted.

Whatever the mode, the output says which one produced it, and `calibrated`
carries its error bar into the JSON. A number that does not say how wrong it
might be is the thing this project exists to replace.

Stdlib only, by design: these scripts are meant to be curled and run.
"""

import argparse
import glob
import json
import os
import statistics
import subprocess
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from releve_cost import (  # noqa: E402
        MILLION,
        UNPRICED,
        PRICED,
        base_rates,
        load_rates,
        price_tokens,
        resolve_model,
        turn_key,
        zero_tokens,
    )
except ImportError:
    # Downloading one of the two files is the likeliest first mistake, because
    # the script that this replaces was a single curl. Say what to fetch rather
    # than showing a traceback.
    sys.exit(
        "releve_cost.py is missing: it holds the rate table and the pricing rules.\n"
        "  curl -O https://releve.neorgon.com/scripts/releve_cost.py\n"
        "Then run this again from the same directory."
    )

SCHEMA = "releve-repo/v1"
TOKENIZER_SCHEMA = "releve-tokenizer/v1"
TOKENIZER_URL = "https://releve.neorgon.com/data/tokenizer.json"
COUNT_URL = "https://api.anthropic.com/v1/messages/count_tokens"
API_VERSION = "2023-06-01"

# Tool inputs whose string fields are known content rather than arguments. This
# is the map that makes calibration possible: the language of a Write's content
# is the language of the file it was written to.
CONTENT_KEYS = ("content", "new_string", "old_string")
PROSE_KEYS = ("prompt", "plan", "description", "message")


# ==========================================================================
# The tokenizer table
# ==========================================================================

def load_tokenizer(source=None, refresh=False):
    """Return (table, provenance). Offline by default, like the rate card."""
    if source:
        if source.startswith(("http://", "https://")):
            with urllib.request.urlopen(source, timeout=15) as fh:
                return json.loads(fh.read().decode("utf-8")), source
        with open(source, encoding="utf-8") as fh:
            return json.load(fh), os.path.abspath(source)

    here = os.path.dirname(os.path.abspath(__file__))
    for candidate in (os.path.join(here, "..", "data", "tokenizer.json"),
                      os.path.join(here, "tokenizer.json"),
                      os.path.join(os.getcwd(), "tokenizer.json")):
        if os.path.exists(candidate):
            with open(candidate, encoding="utf-8") as fh:
                return json.load(fh), os.path.abspath(candidate)

    if refresh:
        with urllib.request.urlopen(TOKENIZER_URL, timeout=15) as fh:
            return json.loads(fh.read().decode("utf-8")), TOKENIZER_URL

    raise SystemExit(
        "no tokenizer table found. Fetch it once:\n"
        f"    curl -O {TOKENIZER_URL}\n"
        "or pass --tokenizer-table <path>, or --tokenizer chars to use a flat divisor."
    )


def classify(path, table):
    """Language for a path. False means deliberately skipped, None means unknown."""
    base = os.path.basename(path)
    if base in table.get("filenames", {}):
        return table["filenames"][base]
    ext = os.path.splitext(base)[1].lower()
    if not ext:
        return None
    if ext in table.get("skip_extensions", []):
        return False
    return table.get("extensions", {}).get(ext)


def factor_for(lang, table, mode, flat):
    if mode == "chars":
        return flat
    return table.get("languages", {}).get(lang) or table.get("default") or flat


# ==========================================================================
# Discovery
# ==========================================================================

def git_files(root):
    """Tracked files, which is the right default: a repo's .gitignore already
    says what is not source. Returns None when this is not a git tree."""
    try:
        out = subprocess.run(
            ["git", "-C", root, "ls-files", "-z", "--cached", "--exclude-standard"],
            capture_output=True, check=True, timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    names = [n for n in out.stdout.decode("utf-8", "replace").split("\0") if n]
    return names or None


def walked_files(root, table):
    """Fallback for a tree that is not a git repo.

    Returns (names, pruned). Pruning a directory is cheap and stops the walk
    descending into node_modules, but the files inside it were still skipped, so
    they are counted. Otherwise the report claims nothing was ignored while the
    browser, which receives the whole FileList and filters it, says otherwise on
    the same tree.
    """
    skip = set(table.get("skip_dirs", []))
    names = []
    pruned = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dropped = [d for d in dirnames if d in skip or d.startswith(".git")]
        dirnames[:] = [d for d in dirnames if d not in dropped]
        for name in dropped:
            for _, _, inside in os.walk(os.path.join(dirpath, name)):
                pruned += len(inside)
        for name in filenames:
            full = os.path.join(dirpath, name)
            names.append(os.path.relpath(full, root))
    return names, pruned


def looks_binary(blob):
    """A NUL byte in the first 8 KB. The same test git uses, and it catches the
    files an extension list never will."""
    return b"\0" in blob[:8192]


# ==========================================================================
# Counting
# ==========================================================================

def count_tree(root, table, mode, flat, api_key=None, quiet=False):
    """Walk the tree once and return a releve-repo/v1 document."""
    root = os.path.abspath(root)
    names = git_files(root)
    discovery = "git ls-files"
    pruned = 0
    if names is None:
        names, pruned = walked_files(root, table)
        discovery = "filesystem walk"

    skip_dirs = set(table.get("skip_dirs", []))
    cap = table.get("max_file_bytes") or 2_097_152

    langs = {}
    files = []
    skipped = {"binary": 0, "ignored": pruned, "too_large": 0, "unknown": 0,
               "unreadable": 0}
    total_bytes = 0
    api_calls = 0

    for rel in sorted(names):
        parts = rel.split(os.sep)
        if any(part in skip_dirs for part in parts):
            skipped["ignored"] += 1
            continue
        lang = classify(rel, table)
        if lang is False:
            skipped["binary"] += 1
            continue
        if lang is None:
            skipped["unknown"] += 1
            continue

        full = os.path.join(root, rel)
        try:
            size = os.path.getsize(full)
        except OSError:
            skipped["unreadable"] += 1
            continue
        if size > cap:
            skipped["too_large"] += 1
            continue
        try:
            with open(full, "rb") as fh:
                blob = fh.read()
        except OSError:
            skipped["unreadable"] += 1
            continue
        if looks_binary(blob):
            skipped["binary"] += 1
            continue

        # Characters, not bytes. A factor of characters-per-token has to be
        # applied to characters, and a UTF-8 byte count overstates every file
        # with an accent in it.
        text = blob.decode("utf-8", "replace")
        chars = len(text)

        if mode == "api":
            tokens = api_count(text, api_key)
            api_calls += 1
            if not quiet and api_calls % 25 == 0:
                print(f"  counted {api_calls:,} files through the API", file=sys.stderr)
        else:
            tokens = round(chars / factor_for(lang, table, mode, flat))

        total_bytes += size
        slot = langs.setdefault(lang, {
            "language": lang, "files": 0, "bytes": 0, "chars": 0, "tokens": 0,
        })
        slot["files"] += 1
        slot["bytes"] += size
        slot["chars"] += chars
        slot["tokens"] += tokens
        files.append({"path": rel, "language": lang, "bytes": size, "tokens": tokens})

    ordered = sorted(langs.values(), key=lambda row: -row["tokens"])
    files.sort(key=lambda row: -row["tokens"])
    tokens = sum(row["tokens"] for row in ordered)

    return {
        "schema": SCHEMA,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "generator": "releve-repo.py",
        "root": os.path.basename(root) or root,
        "discovery": discovery,
        "tokenizer": tokenizer_provenance(table, mode, flat),
        "totals": {
            "files": sum(row["files"] for row in ordered),
            "bytes": total_bytes,
            "chars": sum(row["chars"] for row in ordered),
            "tokens": tokens,
        },
        "languages": ordered,
        "files": files[:40],
        "skipped": skipped,
    }


def tokenizer_provenance(table, mode, flat):
    """What produced the numbers, in the document itself.

    The site badges an `api` count as exact and everything else as an estimate,
    and prints this note, so a file that travels away from its terminal still
    carries its own caveat.
    """
    if mode == "api":
        return {
            "mode": "api",
            "note": "Exact. Every file was counted by /v1/messages/count_tokens.",
            "error_bar": 0.0,
        }
    if mode == "chars":
        return {
            "mode": "chars",
            "note": f"Every file's characters divided by {flat}, one divisor for "
                    "every language. The crude baseline, kept so the value of "
                    "calibrating is visible rather than asserted.",
            "flat_factor": flat,
            "error_bar": None,
        }
    return {
        "mode": "calibrated",
        "note": table.get("note"),
        "error_bar": table.get("error_bar"),
        "error_bar_note": table.get("error_bar_note"),
        "table_verified": table.get("verified"),
        "measured_languages": sorted((table.get("measured") or {}).keys()),
    }


def api_count(text, api_key):
    """One exact count. Deliberately one file per call: batching would make the
    per-file column a share-out of a total rather than a measurement."""
    body = json.dumps({
        "model": "claude-opus-5",
        "messages": [{"role": "user", "content": text}],
    }).encode("utf-8")
    req = urllib.request.Request(COUNT_URL, data=body, method="POST", headers={
        "content-type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": API_VERSION,
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as fh:
            return json.loads(fh.read().decode("utf-8"))["input_tokens"]
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        raise SystemExit(f"count_tokens failed: HTTP {exc.code}. {detail}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"count_tokens unreachable: {exc.reason}") from exc


# ==========================================================================
# Calibration: measure this machine's own factors
# ==========================================================================
#
# The measurement that makes `calibrated` a measurement. One assistant response
# is written to the transcript as several entries sharing a message.id, one per
# content block, each repeating the same usage object. Reassembling those blocks
# recovers exactly the characters whose output_tokens were billed, which is a
# labelled pair: content in, tokens out.
#
# Two things have to be got right or the answer is nonsense.
#
# 1. A response whose thinking block the transcript did not keep has tokens with
#    no characters anywhere. Including it drags the apparent factor below one
#    character per token, which is impossible for text and is how the first
#    attempt at this failed. Those responses are dropped and counted.
# 2. Fitting every language at once does not work. The JSON scaffolding of a tool
#    call appears in nearly every response next to every language, so the system
#    is collinear and a least-squares solver pushes half the coefficients to
#    zero. Measure the scaffolding first, subtract it, then read each language
#    off the residual.

def extract_calibration_rows(root, quiet=False):
    """One row per usable response: (tokens, {language: characters})."""
    group = {}
    files = sorted(glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True))
    for path in files:
        try:
            fh = open(path, encoding="utf-8", errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                try:
                    entry = json.loads(line)
                except (ValueError, TypeError):
                    continue
                if not isinstance(entry, dict) or entry.get("type") != "assistant":
                    continue
                message = entry.get("message")
                if not isinstance(message, dict):
                    continue
                key = turn_key(entry)
                if not key:
                    continue
                usage = message.get("usage") or {}
                row = group.setdefault(key, {
                    "out": 0, "think_tokens": None, "chars": defaultdict(int),
                    "think_chars": 0, "think_blocks": 0,
                })
                out = usage.get("output_tokens") or 0
                if out > row["out"]:
                    row["out"] = out
                    details = usage.get("output_tokens_details")
                    if isinstance(details, dict) and "thinking_tokens" in details:
                        row["think_tokens"] = details.get("thinking_tokens") or 0
                collect_blocks(message, row)

    rows = []
    hidden = 0
    for row in group.values():
        if row["out"] <= 0:
            continue
        visible = sum(row["chars"].values())
        if visible < 40:
            continue
        if row["think_blocks"] == 0 and row["think_tokens"] in (0, None):
            target = row["out"]
        elif row["think_blocks"] and row["think_chars"] > 0 and row["think_tokens"]:
            # Thinking text is present and its token count is known, so the two
            # halves separate cleanly.
            target = row["out"] - row["think_tokens"]
        else:
            hidden += 1
            continue
        if target > 0:
            rows.append((target, dict(row["chars"])))

    if not quiet:
        print(f"  {len(files):,} transcripts · {len(group):,} responses · "
              f"{len(rows):,} usable · {hidden:,} dropped for unrecoverable thinking")
    return rows


def collect_blocks(message, row):
    """Attribute one entry's content blocks to languages."""
    content = message.get("content")
    if not isinstance(content, list):
        return
    for block in content:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind == "text":
            row["chars"]["prose"] += len(block.get("text") or "")
        elif kind in ("thinking", "redacted_thinking"):
            row["think_blocks"] += 1
            row["think_chars"] += len(block.get("thinking") or "")
        elif kind == "tool_use":
            inputs = block.get("input")
            if not isinstance(inputs, dict):
                continue
            name = block.get("name") or ""
            # The block goes over the wire as JSON, so its keys, braces and
            # escaping are tokenized too. Measure the whole serialization and
            # attribute the recognisable content out of it; the remainder is
            # scaffolding.
            total = len(json.dumps(inputs, ensure_ascii=False))
            total += 46 + len(name) + len(block.get("id") or "")
            attributed = 0
            for key, value in inputs.items():
                if not isinstance(value, str):
                    continue
                lang = None
                if name == "Bash" and key == "command":
                    lang = "shell"
                elif key in CONTENT_KEYS:
                    lang = lang_from_path(inputs.get("file_path")) or "text"
                elif key in PROSE_KEYS:
                    lang = "prose"
                if lang:
                    row["chars"][lang] += len(value)
                    attributed += len(value)
            row["chars"]["json"] += max(0, total - attributed)


CALIB_EXT = None  # filled from the tokenizer table on first use


def lang_from_path(path):
    if not path or not CALIB_EXT:
        return None
    base = os.path.basename(path)
    if base in CALIB_EXT[1]:
        return CALIB_EXT[1][base]
    return CALIB_EXT[0].get(os.path.splitext(base)[1].lower())


def fit_factors(rows, table, min_responses=25, dominance=0.85):
    """Two stages, as described above. Returns (measured, scored_error)."""
    # Stage 1: the scaffolding, from responses that are almost nothing else.
    pure = [(r[1].get("json", 0), r[0]) for r in rows
            if sum(r[1].values()) >= 200
            and r[1].get("json", 0) >= 0.97 * sum(r[1].values())]
    if not pure:
        raise SystemExit("not enough tool-call responses to calibrate. Need a longer history.")
    k_json = sum(t for _, t in pure) / sum(c for c, _ in pure)

    measured = {}
    ratios = sorted(c / t for c, t in pure)
    measured["json"] = summarise(sum(c for c, _ in pure), sum(t for _, t in pure), ratios)

    # Stage 2: every other language, with the scaffolding's tokens removed.
    for lang in sorted({lang for _, chars in rows for lang in chars}):
        if lang == "json":
            continue
        each, chars_sum, token_sum = [], 0, 0.0
        for target, chars in rows:
            non_json = sum(n for k, n in chars.items() if k != "json")
            if non_json < 300 or chars.get(lang, 0) < dominance * non_json:
                continue
            residual = target - chars.get("json", 0) * k_json
            if residual <= 0:
                continue
            each.append(non_json / residual)
            chars_sum += non_json
            token_sum += residual
        if len(each) < min_responses:
            continue
        measured[lang] = summarise(chars_sum, token_sum, sorted(each))

    return measured, score_table(rows, measured, table)


def summarise(chars, tokens, ratios):
    return {
        "factor": round(chars / tokens, 2),
        "median": round(statistics.median(ratios), 2),
        "p25": round(ratios[int(0.25 * (len(ratios) - 1))], 2),
        "p75": round(ratios[int(0.75 * (len(ratios) - 1))], 2),
        "responses": len(ratios),
        "chars": int(chars),
    }


def score_table(rows, measured, table):
    """Predict every response's tokens from the fitted table and report the
    error. This, not the fit's own residual, is what a repo count's accuracy
    depends on, so it is the number that gets published."""
    default = table.get("default") or 3.0
    errors = []
    for target, chars in rows:
        predicted = 0.0
        for lang, n in chars.items():
            factor = (measured.get(lang) or {}).get("factor") or default
            predicted += n / factor
        if predicted > 0:
            errors.append(abs(predicted - target) / target)
    errors.sort()
    if not errors:
        return None
    return {
        "median_ape": round(statistics.median(errors), 3),
        "p25_ape": round(errors[int(0.25 * (len(errors) - 1))], 3),
        "p75_ape": round(errors[int(0.75 * (len(errors) - 1))], 3),
        "p90_ape": round(errors[int(0.90 * (len(errors) - 1))], 3),
        "responses": len(errors),
    }


def calibrate(args, table, provenance):
    """--calibrate: rewrite the tokenizer table from this machine's transcripts."""
    global CALIB_EXT
    CALIB_EXT = (table.get("extensions", {}), table.get("filenames", {}))

    print(f"Releve calibration  ·  reading {args.transcripts}")
    rows = extract_calibration_rows(args.transcripts, quiet=args.quiet)
    if len(rows) < 500:
        print(f"  only {len(rows):,} usable responses. The factors below will be noisy; "
              "the shipped table was fitted on 28,678.")
    measured, score = fit_factors(rows, table)

    print()
    print(f"  {'language':<12} {'factor':>7} {'median':>7} {'p25':>6} {'p75':>6} "
          f"{'n':>7} {'chars':>12}")
    for lang, row in sorted(measured.items(), key=lambda kv: -kv[1]["chars"]):
        print(f"  {lang:<12} {row['factor']:>7.2f} {row['median']:>7.2f} "
              f"{row['p25']:>6.2f} {row['p75']:>6.2f} {row['responses']:>7,} "
              f"{row['chars']:>12,}")

    if score:
        print()
        print(f"  Predicting a whole response from this table: median error "
              f"{score['median_ape'] * 100:.1f}% over {score['responses']:,} responses "
              f"(p25 {score['p25_ape'] * 100:.1f}%, p75 {score['p75_ape'] * 100:.1f}%, "
              f"p90 {score['p90_ape'] * 100:.1f}%).")
        print("  What this does not check is the absolute level: every factor here comes")
        print("  from output tokens, so a bias shared by all of them would not show up.")
        print("  --tokenizer api on any tree settles that in one pass.")

    if not args.out:
        print()
        print("  Nothing written. Add --out tokenizer.json to save this table,")
        print("  then pass --tokenizer-table tokenizer.json when counting.")
        return 0

    # `prose` is the assistant's own text. It is not a file type, so it does not
    # belong in `languages`, but markdown measured independently should agree
    # with it, and saying so is how a reader checks the method.
    updated = dict(table)
    languages = dict(table.get("languages", {}))
    for lang, row in measured.items():
        if lang in languages or lang in ("json", "text"):
            languages[lang] = row["factor"]
    updated["languages"] = languages
    updated["measured"] = measured
    updated["verified"] = datetime.now(timezone.utc).date().isoformat()
    updated["measured_source"] = {
        "responses_scored": (score or {}).get("responses"),
        "responses_attributed": sum(r["responses"] for r in measured.values()),
        "method": "output_tokens of one response against the characters of its own "
                  "content blocks, reassembled across the entries that share its message.id",
        "machine": "local, by releve-repo.py --calibrate",
        "base_table": provenance,
    }
    if score:
        updated["error_bar"] = score["median_ape"]
        updated["error_bar_note"] = (
            f"Median absolute percentage error of {score['median_ape'] * 100:.1f}% "
            f"predicting a whole response from this table, over "
            f"{score['responses']:,} responses (p25 {score['p25_ape'] * 100:.1f}%, "
            f"p75 {score['p75_ape'] * 100:.1f}%, p90 {score['p90_ape'] * 100:.1f}%). "
            "Measured here, on this machine. The absolute level is unchecked: "
            "use --tokenizer api to settle it."
        )
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(updated, fh, indent=2)
        fh.write("\n")
    print()
    print(f"  wrote {args.out}. Use it with --tokenizer-table {args.out}.")
    return 0


# ==========================================================================
# The projector: what N iterations over this repo will cost
# ==========================================================================

def project(repo, args, rates, calibration):
    """Forecast a stretch of work, from measured medians where they exist.

    The honest version of a number people usually guess. Every input is either
    read from a releve.json this machine produced or supplied on the command
    line, and the output names which.
    """
    model = args.model
    canonical, entry, status = resolve_model(model, rates)
    if status == UNPRICED:
        raise SystemExit(f"{model} has no published rate in the loaded rate card, "
                         "so this projection would be a guess. Pick a priced model.")

    per_turn = (calibration or {}).get("tokens_per_turn", {})
    measured = ((per_turn.get(canonical) or {}).get(args.effort)
                or (per_turn.get(canonical) or {}).get("xhigh") or {})
    source = "measured" if measured else "assumed"

    output_p50 = args.output_per_turn or measured.get("output_p50") or 430
    read_p50 = args.cache_read_per_turn or measured.get("cache_read_p50") or 200_000
    write_p50 = args.cache_write_per_turn or measured.get("cache_write_p50") or 1_100
    input_p50 = measured.get("input_p50") or 2

    turns_source = "given"
    turns = args.turns_per_iteration
    if not turns:
        tps = (calibration or {}).get("turns_per_session") or {}
        turns = tps.get("p50") or 200
        turns_source = "measured" if tps.get("p50") else "assumed"

    hit = args.cache_hit
    if hit is None:
        hit = (calibration or {}).get("cache_hit_ratio")
        hit_source = "measured" if hit is not None else "assumed"
        if hit is None:
            hit = 0.97
    else:
        hit_source = "given"

    total_turns = args.iterations * turns

    # The repo is what gets read. A turn's context is some of it; the cache-hit
    # ratio decides how much of that arrives as a read rather than a write.
    context = repo["totals"]["tokens"] if repo else read_p50
    per_turn_context = min(context, read_p50 + write_p50) if repo else read_p50 + write_p50

    tokens = zero_tokens()
    tokens["output"] = int(output_p50 * total_turns)
    tokens["input"] = int(input_p50 * total_turns)
    tokens["cache_read"] = int(per_turn_context * hit * total_turns)
    fresh = per_turn_context * (1 - hit) * total_turns
    share_1h = args.cache_1h_share
    tokens["cache_write_1h"] = int(fresh * share_1h)
    tokens["cache_write_5m"] = int(fresh - tokens["cache_write_1h"])

    cost, _, _ = price_tokens(tokens, entry, rates, None, None, None)

    # Sensitivity: which lever actually moves this. One at a time, plus or minus
    # a quarter, so the ranking is about the bill and not about the slider.
    # Iterations and turns-per-iteration are one lever, not two: only their
    # product reaches the bill, so raising either by a quarter costs the same.
    # Listing them separately would show two identical rows and read as a bug.
    levers = []
    for label, mutate in (
        ("total turns", lambda t: scale(t, ("cache_read", "cache_write_5m",
                                            "cache_write_1h", "output", "input"))),
        ("context per turn", lambda t: scale(t, ("cache_read", "cache_write_5m",
                                                 "cache_write_1h"))),
        ("output per turn", lambda t: scale(t, ("output",))),
        ("cache hit ratio", lambda t: shift_hit(t)),
    ):
        moved = mutate(dict(tokens))
        moved_cost, _, _ = price_tokens(moved, entry, rates, None, None, None)
        levers.append({
            "lever": label,
            "delta": round(moved_cost["total"] - cost["total"], 2),
            "share": round((moved_cost["total"] - cost["total"]) / cost["total"], 4)
            if cost["total"] else None,
        })
    levers.sort(key=lambda row: -abs(row["delta"]))

    input_rate, output_rate = base_rates(entry, None, None)
    return {
        "model": canonical,
        "effort": args.effort,
        "iterations": args.iterations,
        "turns_per_iteration": turns,
        "total_turns": total_turns,
        "cache_hit_ratio": hit,
        "sources": {"per_turn_medians": source, "turns_per_iteration": turns_source,
                    "cache_hit_ratio": hit_source},
        "rates": {"input": input_rate, "output": output_rate},
        "tokens": tokens,
        "cost": {k: round(v, 2) for k, v in cost.items()},
        "plan_cost": args.plan_cost,
        "levers": levers,
    }


def scale(tokens, keys, by=0.25):
    for key in keys:
        tokens[key] = int(tokens[key] * (1 + by))
    return tokens


def shift_hit(tokens, by=0.25):
    """A quarter of the cache reads become fresh writes, which is what a worse
    hit ratio does: the same context, at ten to twenty times the rate."""
    moved = int(tokens["cache_read"] * by)
    tokens["cache_read"] -= moved
    tokens["cache_write_5m"] += moved
    return tokens


# ==========================================================================
# Reporting
# ==========================================================================

def report(repo, rates, projection, plan_cost, model):
    print()
    t = repo["totals"]
    mode = repo["tokenizer"]["mode"]
    print(f"Releve repo  ·  {repo['root']}  ·  {mode}")
    print(f"  {t['files']:,} files · {t['chars']:,} chars · {t['tokens']:,} tokens "
          f"({repo['discovery']})")

    bar = repo["tokenizer"].get("error_bar")
    if mode == "api":
        print("  Exact: every file counted by the token-counting endpoint.")
    elif bar:
        low, high = t["tokens"] * (1 - bar), t["tokens"] * (1 + bar)
        print(f"  Estimated, +/-{bar * 100:.0f}%: {low:,.0f} to {high:,.0f} tokens. "
              "Run --tokenizer api for the exact figure.")
    else:
        print("  Estimated, error not measured for this mode.")

    canonical, entry, status = resolve_model(model, rates)
    rate = base_rates(entry, None, None)[0] if status == PRICED else None

    print()
    header = f"cost once at {canonical}" if rate else "cost once"
    print(f"  {'language':<12} {'files':>6} {'tokens':>12} {'share':>7}  {header}")
    for row in repo["languages"][:14]:
        share = row["tokens"] / (t["tokens"] or 1)
        cost = money(row["tokens"] * rate / MILLION) if rate else "unpriced"
        print(f"  {row['language']:<12} {row['files']:>6,} {row['tokens']:>12,} "
              f"{share * 100:>6.1f}%  {cost}")

    print()
    print("  Whole tree as fresh input, once, and how much of a context window it fills")
    for name, model in sorted((rates.get("models") or {}).items()):
        if model.get("excluded") or not model.get("periods") or not model.get("context"):
            continue
        inp, _ = base_rates(model, None, None)
        if inp is None:
            continue
        frac = t["tokens"] / model["context"]
        flag = "  DOES NOT FIT" if frac > 1 else ""
        print(f"    {name:<22} {frac * 100:>6.1f}% of {model['context']:>10,}  "
              f"{money(t['tokens'] * inp / MILLION)}{flag}")
    print("  A single cold read of everything. Real work re-reads a subset many times,")
    print("  most of it from cache at a tenth of the rate, so this is a ceiling.")

    if repo["skipped"]:
        parts = [f"{n:,} {k.replace('_', ' ')}" for k, n in repo["skipped"].items() if n]
        if parts:
            print()
            print(f"  Skipped: {', '.join(parts)}.")

    if projection:
        report_projection(projection, plan_cost)


def report_projection(p, plan_cost):
    print()
    print(f"Projection  ·  {p['iterations']:,} iterations x "
          f"{p['turns_per_iteration']:,} turns = {p['total_turns']:,} turns")
    print(f"  {p['model']} at {p['effort']} effort, "
          f"{p['cache_hit_ratio'] * 100:.1f}% cache hit")
    sources = ", ".join(f"{k.replace('_', ' ')} {v}" for k, v in p["sources"].items())
    print(f"  inputs: {sources}")
    print()
    for key in ("input", "output", "cache_write", "cache_read"):
        print(f"  {key:<14} {money(p['cost'][key]):>14}")
    print(f"  {'total':<14} {money(p['cost']['total']):>14}")
    if plan_cost:
        months = p["cost"]["total"] / plan_cost
        print(f"  {'as plan':<14} {months:>13.1f} months at ${plan_cost:,.0f}/mo")
    print()
    print("  Which lever moves it, each raised a quarter on its own")
    for row in p["levers"]:
        share = "" if row["share"] is None else f"{row['share'] * 100:+.1f}%"
        print(f"    {row['lever']:<22} +{money(row['delta']):>12}  {share}")


def money(v):
    if v is None:
        return "n/a"
    return f"${v:,.2f}"



# ==========================================================================
# Entry point
# ==========================================================================

def main():
    ap = argparse.ArgumentParser(
        description="Count and price a codebase, and project work over it",
        epilog="Every number states which mode produced it. See --help output above.",
    )
    ap.add_argument("path", nargs="?", help="repository root to count")
    ap.add_argument("--out", help="write the JSON document here")
    ap.add_argument("--tokenizer", choices=("calibrated", "api", "chars"),
                    default="calibrated", help="how to turn characters into tokens")
    ap.add_argument("--tokenizer-table", help="path or URL of a releve-tokenizer/v1 file")
    ap.add_argument("--tokenizer-refresh", action="store_true",
                    help="fetch the table from releve.neorgon.com if none is local")
    ap.add_argument("--flat-factor", type=float, default=3.5,
                    help="divisor for --tokenizer chars (default 3.5)")
    ap.add_argument("--rates", help="rate card path or URL (default: offline)")
    ap.add_argument("--quiet", action="store_true", help="suppress progress")

    ap.add_argument("--calibrate", action="store_true",
                    help="measure this machine's chars-per-token factors and print them")
    ap.add_argument("--transcripts", default=os.path.expanduser("~/.claude/projects"),
                    help="transcript root for --calibrate")

    ap.add_argument("--project", action="store_true", help="also project work forward")
    ap.add_argument("--from", dest="releve", help="a releve.json, for measured medians")
    ap.add_argument("--iterations", type=int, default=10)
    ap.add_argument("--turns-per-iteration", type=int,
                    help="default: the p50 session length in --from, else 200")
    ap.add_argument("--cache-hit", type=float,
                    help="0..1; default: the ratio measured in --from")
    ap.add_argument("--cache-1h-share", type=float, default=0.67,
                    help="share of cache writes taken at the 1-hour TTL")
    ap.add_argument("--model", default="claude-opus-5")
    ap.add_argument("--effort", default="xhigh")
    ap.add_argument("--output-per-turn", type=int, help="override the measured median")
    ap.add_argument("--cache-read-per-turn", type=int, help="override the measured median")
    ap.add_argument("--cache-write-per-turn", type=int, help="override the measured median")
    ap.add_argument("--plan-cost", type=float, default=100.0,
                    help="monthly subscription, for the months-of-plan line")
    args = ap.parse_args()

    if not args.path and not args.calibrate:
        ap.error("give a path to count, or --calibrate")

    rates, rate_provenance = load_rates(args.rates)

    if args.tokenizer == "chars" and not args.calibrate:
        table, table_provenance = {}, f"flat divisor {args.flat_factor}"
        try:
            table, table_provenance = load_tokenizer(args.tokenizer_table,
                                                     args.tokenizer_refresh)
        except SystemExit:
            # chars mode needs the extension map but not the factors, so a
            # missing table is only fatal if there is no fallback at all.
            raise
    else:
        table, table_provenance = load_tokenizer(args.tokenizer_table,
                                                 args.tokenizer_refresh)

    if table and table.get("schema") not in (None, TOKENIZER_SCHEMA):
        raise SystemExit(f"{table_provenance}: expected schema {TOKENIZER_SCHEMA}, "
                         f"found {table.get('schema')!r}")

    if args.calibrate:
        return calibrate(args, table, table_provenance)

    api_key = None
    if args.tokenizer == "api":
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise SystemExit(
                "--tokenizer api needs ANTHROPIC_API_KEY in the environment. "
                "It is the only exact mode; without a key, use the default."
            )

    if not args.quiet:
        print(f"Releve repo  ·  counting {os.path.abspath(args.path)}", file=sys.stderr)
    repo = count_tree(args.path, table, args.tokenizer, args.flat_factor,
                      api_key=api_key, quiet=args.quiet)

    calibration = None
    if args.releve:
        with open(args.releve, encoding="utf-8") as fh:
            calibration = (json.load(fh) or {}).get("calibration")

    projection = project(repo, args, rates, calibration) if args.project else None
    if projection:
        repo["projection"] = projection

    repo["rates"] = {
        "version": rates.get("version"),
        "verified": rates.get("verified"),
        "source": rates.get("source"),
        "provenance": rate_provenance,
    }
    repo["tokenizer"]["table"] = table_provenance

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(repo, fh, indent=2)
            fh.write("\n")

    report(repo, rates, projection, args.plan_cost, args.model)

    if args.out:
        print()
        print(f"  wrote {args.out}. Drop it on section 5 of releve.neorgon.com.")
    print(f"  rates as of {rates.get('verified')}. A counterfactual at list rates, "
          "not an invoice.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
