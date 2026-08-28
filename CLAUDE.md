# CLAUDE.md: Releve

Releve: price your Claude Code transcripts at real API rates. Reads
`~/.claude/projects/**/*.jsonl` with four stdlib-only Python scripts, and renders
the result as an eight-section statement: cost by model, project, skill and
effort, a cache lab, a repo token scanner, an iteration projector, an editable
rate card, and a method page that reports its own parity check. Modular ES
modules, no build, no backend, nothing uploaded (releve.neorgon.com)

**Live:** releve.neorgon.com · **Port:** 8874

## Run

```bash
make serve      # http://localhost:8874
make test       # the 49-case pricing fixture, Python side
make schema     # every data/*.json against data/schema.json
make mine       # scan real transcripts into data/local.json (gitignored)
make demo       # regenerate data/demo.json, with a leak check
make parity     # releve-scan.py and releve-mini.py must agree to the cent
```

It must be served over HTTP. The app is ES modules, and `file://` blocks them.

## The engine is written twice, on purpose

`scripts/releve_cost.py` and `js/cost.js` implement the same pricing rules in two
languages. `data/testcases.json` (46 pricing cases plus 3 dedup cases) is the only
thing stopping them from drifting: `scripts/test_cost.py` asserts the Python half,
`selfCheck()` in `js/cost.js` asserts the JS half against the same file, and
section 8 of the site prints the verdict.

**Run `make test` before and after any edit to either engine file.** A change made
to one and not the other is the single failure mode this project is built to
prevent, and the fixture is the only thing that catches it.

## Architecture

| Module | Owns |
|---|---|
| `js/cost.js` | THE ENGINE: `resolveModel`, `baseRates`, `extractTokens`, `priceTokens`, `priceTurn`, `turnKey`, `Bucket`, `selfCheck`. Twin of `scripts/releve_cost.py` |
| `js/rates.js` | `loadRates`, `effectiveRates` (base plus user overrides), `publishedPair`, `modelsInPlay` |
| `js/state.js` | `DIMS`, `state`, `loadSaved`, `save`, `hasRateEdits`; `localStorage['releve-state']` |
| `js/ingest.js` | `loadDefault` (local.json, else demo.json), `fromFile`, `priceTranscript` (a raw `.jsonl` priced in the browser), `validate` |
| `js/filters.js` | `buildView` (the one place a filtered, priced view is computed), `sortRows`, `WINDOWS`, `presetWindow` |
| `js/render.js` | `render`, `renderProjection`, `renderRepoSection`, `renderFailure`; orchestration only |
| `js/widgets/kpi.js` | section 1: `sourceBanner`, `headline`, `statementNote`, `statementStats`, `filterChips` |
| `js/widgets/timeline.js` | section 2: `presets`, `chart`, `legend`, `trend`, `bucketAtPointer` |
| `js/widgets/breakdown.js` | section 3: `tabs`, `chart`, `table`, `note` |
| `js/widgets/cache.js` | section 4: `headline`, `mix`, `ratio`, `note`, `table` |
| `js/widgets/repo.js` | section 5: `loadTokenizer`, `validate`, `countFolder` (browser count), `render` |
| `js/widgets/projector.js` | section 6: `calibrated`, `seed`, `project`, `output`, `sensitivity`, `note` |
| `js/widgets/ratecard.js` | section 7: `provenance`, `table`, `multipliers`, `tiers`, `sensitivity` |
| `js/widgets/method.js` | section 8: `parity`, `quality`, `limits`, `scriptList` |
| `js/events.js` | `bindEvents`, `adoptDoc`, `openModal`, `closeModal`. Every listener; no inline onclick |
| `js/utils.js` | `money`, `big`, `count`, `pct`, `mult`, `shortModel`, `NO_VALUE`, `downloadJson` |
| `js/app.js` | the boot order, and nothing else: ingest, then render, then bind. 41 lines, exports nothing |

Vendored, never edit in place: `js/neorgon-header.js`, `js/neorgon-footer.js`,
`js/viz.js`, `css/neorgon-*.css`, `css/viz.css`. Fix `packages/neorgon-ui/` and
re-run its sync script.

## Data contract

Every file under `data/` carries a `schema` string, and every one of them is also
a script's input or output:

| File | Schema | Written by |
|---|---|---|
| `rates.json` | `releve-rates/v1` | by hand, from the public pricing page, with a `verified` date |
| `tokenizer.json` | `releve-tokenizer/v1` | `releve-repo.py --calibrate --out`, never by hand |
| `testcases.json` | `releve-testcases/v1` | by hand; the fixture both engines assert against |
| `demo.json` | `releve/v1` | `make-demo.py`; synthetic, published |
| `local.json` | `releve/v1` | `make mine`; real, gitignored, never committed |
| `releve-repo.json` | `releve-repo/v1` | `releve-repo.py`, or `countFolder()` in the browser |
| `schema.json` | `releve-schemas` (the contract itself) | by hand, from the writers; asserted by `make schema` |

`make schema` checks every file above against `data/schema.json`, and `make mine`
and `make demo` run it on what they just wrote. `releve/v1` and `releve-repo/v1`
are **closed**: an undocumented key is a failure, because those two are what the
site reads back, and a field added to a scanner and not to the viewer is how the
two start disagreeing. `scripts/check-schema.py` is a validator for the subset of
JSON Schema the file uses, and it **rejects a keyword it cannot enforce** rather
than skipping it, so the schema cannot quietly grow a constraint that nothing
checks.

Cache rates are **derived** from base input times a multiplier, never typed per
model, so correcting a base rate can never leave a stale cache rate behind.

No output from any script contains prompt or response text: usage counters and
labels only. `--anonymize` additionally hashes project labels and drops `cwd`,
`gitBranch`, `title` and `slug`.

## Conventions

- Zero build step. Plain ES modules loaded by `js/app.js`.
- `UNPRICED` is a status, not a zero. A model with no published rate is named,
  counted in its own bucket, and left out of every total. Never substitute a
  similar model's rate, and never render `$0.00` for an unpriced row.
- Never state a measurement that was not taken. Every accuracy claim on the site
  cites the run that produced it, and what it does not check is stated next to it.
- The empty cell is the word `none` (`NO_VALUE` in `js/utils.js`), fleet-wide.
- Header and footer come from the shared kits. No site-local `.neo-footer` or
  `.header-bar` CSS. Header is `app` mode with `data-header-skin="brass"`.
- Every chart is a builder from `js/viz.js`. Do not hand-roll an SVG.
- The fleet guideline is ~500 lines per module. `css/style.css` is over it because
  it is one file by convention; no JS module is.

## Gotchas

- **A response is billed once, and it is written to the transcript many times.**
  One JSONL entry per content block, every entry repeating the same `usage`
  object, so a turn that thought, spoke and called a tool appears three times.
  Dedup keys on `message.id` (`turnKey()`); keying on the entry's `uuid` reports
  30.0B cache-read tokens on this machine against a true 12.9B. Resuming a session
  also replays its history into a new transcript, and the replay is sometimes the
  fuller record, so the copy with the most billable tokens wins.
- **`usage.iterations` replaces the top-level counters, it does not add to them.**
  Measured over 115,192 real turns: on every single-iteration turn the sum equals
  the top level exactly, and on every multi-iteration turn the top level equals
  the *last* iteration alone. So summing on top double-counts, and ignoring the
  array under-reports every multi-iteration turn and misses turns whose top-level
  counters are all zero. Six fixture cases pin both halves.
- **`git ls-files` returns nothing inside `projects/`.** Every project here is its
  own repo but the root repo excludes `projects/*`, so `releve-repo.py` run on a
  path under the monorepo takes its filesystem-walk fallback. That path must count
  the files inside directories it prunes, or its `skipped.ignored` disagrees with
  the browser's, which receives the whole `FileList` and filters it. The two
  counters were made to agree on an identical tree; keep them that way.
- **`data/tokenizer.json` is generated, not authored.** Regenerate it with
  `releve-repo.py --calibrate --out data/tokenizer.json` and take the numbers from
  the script's own output. A hand-typed factor is how `jsx` once shipped carrying
  a copy of typescript's number, presented as measured.
- **The tokenizer's absolute level is unverified.** Every factor is fitted from
  output tokens, so a bias common to all of them would not show up in the 20.7%
  median error. `--tokenizer api` settles it and needs `ANTHROPIC_API_KEY`, which
  was not available when the table was fitted. The site says so; do not quietly
  upgrade the claim.
- **`404` on `data/local.json` in the console is expected.** `loadDefault()` probes
  for it and falls back to `demo.json`. The file only exists after `make mine`.
- **Iterations and turns-per-iteration are one lever, not two.** Only their
  product reaches the bill, so the projector's sensitivity ranking merges them
  into `total turns`. Listing them separately prints two identical rows and reads
  as a bug.
- **`make parity` runs against a frozen snapshot** because the live transcript
  tree grows while the two scanners are reading it. A direct comparison of two
  live runs fails for that reason alone.

## Do not touch

- `js/neorgon-*.js`, `css/neorgon-*.css`, `js/viz.js`, `css/viz.css`: vendored
  kits, regenerated by `packages/neorgon-ui/sync-*.sh` and the `/viz` command.
- `data/tokenizer.json`: regenerate with `--calibrate`.
- `data/local.json`: real data, gitignored. Never commit it, never publish it.
