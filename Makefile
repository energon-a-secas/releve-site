.DEFAULT_GOAL := help

PORT = 8874

# ── Help ──────────────────────────────────────────────────────────────────────
.PHONY: help
help:
	@echo ""
	@echo "  make serve    Start dev server → http://localhost:$(PORT)"
	@echo "  make kill     Kill this project's HTTP server"
	@echo ""
	@echo "  make test     Pricing engine parity fixture (run before any engine edit)"
	@echo "  make mine     Scan your own transcripts → data/local.json (gitignored)"
	@echo "  make demo     Regenerate the public synthetic dataset → data/demo.json"
	@echo "  make parity   Assert releve-scan.py and releve-mini.py agree to the cent"
	@echo ""

# ── Pricing engine ────────────────────────────────────────────────────────────
# The correctness core is implemented twice, in scripts/releve_cost.py and in
# js/cost.js. data/testcases.json is the fixture that keeps them equal, and this
# target asserts the Python half plus the embedded rate table.
.PHONY: test
test:
	@python3 scripts/test_cost.py

# ── Datasets ──────────────────────────────────────────────────────────────────
# Real numbers on localhost, synthetic numbers in public, one code path:
# js/ingest.js prefers data/local.json when it exists and falls back to demo.
.PHONY: mine
mine:
	@python3 scripts/releve-scan.py --out data/local.json

.PHONY: demo
demo:
	@python3 scripts/make-demo.py
	@if grep -qE "$${USER:-__no_user__}|/Users/|/home/|dev/Personal" data/demo.json; then \
		echo "FAIL: demo.json contains a real path or username"; exit 1; \
	else echo "  leak check clean"; fi

# ── Script parity ─────────────────────────────────────────────────────────────
# The two scanners share one engine, so a disagreement means one of them reads
# or dedupes the transcripts differently. Runs against a frozen snapshot,
# because the live transcript tree grows while the scripts are reading it.
.PHONY: parity
parity:
	@bash scripts/check-parity.sh

# ── Dev server ────────────────────────────────────────────────────────────────
# scripts/serve.py is http.server plus Cache-Control: no-cache; a plain
# http.server sends only Last-Modified, so browsers keep stale ES modules after
# edits. Falls back to plain http.server outside the monorepo.
.PHONY: serve
serve:
	@echo "Serving → http://localhost:$(PORT)"
	@if [ -f ../../scripts/serve.py ]; then python3 ../../scripts/serve.py $(PORT); else python3 -m http.server $(PORT); fi

# ── Kill ──────────────────────────────────────────────────────────────────────
.PHONY: kill
kill:
	@lsof -ti :$(PORT) | xargs kill 2>/dev/null && echo "Stopped server on port $(PORT)" || echo "No server running on port $(PORT)"
