#!/usr/bin/env bash
# releve-scan.py and releve-mini.py must agree to the cent.
#
# They share scripts/releve_cost.py, so a disagreement is never a pricing bug:
# it means one of them walks the tree, filters the window, or dedupes replayed
# turns differently from the other. That is the class of bug the old
# claude-costs.py shipped with, so it gets a test.
#
# The scan runs against a frozen copy of ~/.claude/projects. The live tree grows
# while the scripts are reading it, so two runs against it never match, and a
# flapping test is worse than none.

set -euo pipefail
cd "$(dirname "$0")/.."

SRC="${RELEVE_ROOT:-$HOME/.claude/projects}"
SNAP="$(mktemp -d -t releve-parity)"
trap 'rm -rf "$SNAP"' EXIT

echo "  snapshotting $SRC"
cp -R "$SRC" "$SNAP/projects"
FILES=$(find "$SNAP/projects" -name '*.jsonl' | wc -l | tr -d ' ')
echo "  $FILES transcripts frozen"

fail=0
for days in 1 7 30 90; do
  python3 scripts/releve-scan.py --root "$SNAP/projects" --days "$days" \
    --out "$SNAP/scan.json" --quiet
  scan=$(python3 -c "import json;print('%.2f'%json.load(open('$SNAP/scan.json'))['totals']['cost']['total'])")
  mini=$(python3 scripts/releve-mini.py --root "$SNAP/projects" --days "$days" \
    | sed -n '2s/.*\$//p' | tr -d ,)
  if [ "$scan" = "$mini" ]; then
    printf "  %3sd  \$%-14s match\n" "$days" "$scan"
  else
    printf "  %3sd  scan \$%s  mini \$%s  DISAGREE\n" "$days" "$scan" "$mini"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "FAIL: the two scanners disagree about money"
  exit 1
fi
echo "  both scanners agree on every window"
