// ── The pricing engine ───────────────────────────────────────
// Mirror of scripts/releve_cost.py. Every dollar figure on this page comes from
// here, and data/testcases.json is the fixture that keeps the two sides equal.
// If you change a rule, change it in both files and re-run:
//
//   python3 scripts/test_cost.py       # Python side
//   selfCheck() below                  # browser side, run automatically on localhost
//
// Six rules, all of which the tool this replaced broke:
//
//   1. Resolve rates per turn, from that turn's own message.model.
//   2. Never substitute a different model's rates. Exact id, then longest
//      declared prefix, then UNPRICED. Unknown is reported, never zeroed.
//   3. Split the cache writes: 5-minute at 1.25x base input, 1-hour at 2.0x.
//   4. Honour usage.speed. Fast mode on Opus bills double.
//   5. usage.iterations is authoritative when present, and is never ADDED to
//      the top-level counters. Measured on 115,192 real turns: on all 77,063
//      single-iteration turns the sum of iterations equals the top-level
//      counters exactly, and on every multi-iteration turn the top-level
//      counters equal the LAST iteration alone, so the sum is larger and the
//      top level under-reports. Adding the two double-counts; ignoring the
//      array under-counts. Summing it and using it in place of the top level is
//      correct in both cases.
//   6. Count each response once, keyed on message.id and not on the entry uuid.
//      See turnKey() below for the measurement; it is the rule with the largest
//      consequence of any here.
//
// output_tokens_details.thinking_tokens is already inside output_tokens. It is
// carried as a label and never added to cost.
//
// usage.service_tier scales every rate: batch is half price. A tier whose
// pricing is not a flat multiple of standard (priority) is priced at standard
// and flagged tier_assumed, never guessed at. usage.inference_geo is not a
// pricing signal: it reads "not_available" or "" in practice.

export const MILLION = 1_000_000;

export const PRICED = 'priced';
export const UNPRICED = 'unpriced';
export const EXCLUDED = 'excluded';

const FALLBACK_MULTIPLIERS = {
  cache_write_5m: 1.25,
  cache_write_1h: 2.0,
  cache_read: 0.1,
  batch: 0.5,
};

const FALLBACK_TIERS = {
  standard: { multiplier: 1.0 },
  batch: { multiplier: 0.5 },
  priority: { multiplier: null },
};

// ── Model resolution ─────────────────────────────────────────

/**
 * Map a transcript model id to a rate card entry.
 * Rule 2: exact, then longest declared prefix or suffix, then unpriced.
 * A suffix match catches region-prefixed ids (us.anthropic.claude-opus-5).
 * @returns {{canonical: string|null, entry: object|null, status: string}}
 */
export function resolveModel(modelName, rates) {
  if (!modelName) return { canonical: null, entry: null, status: UNPRICED };

  const models = (rates && rates.models) || {};

  const classify = (key, entry) => {
    if (entry.excluded) return { canonical: key, entry, status: EXCLUDED };
    if (!entry.periods || !entry.periods.length) {
      return { canonical: key, entry, status: UNPRICED };
    }
    return { canonical: key, entry, status: PRICED };
  };

  if (Object.prototype.hasOwnProperty.call(models, modelName)) {
    return classify(modelName, models[modelName]);
  }

  let best = null;
  for (const key of Object.keys(models)) {
    if (modelName.startsWith(key) || modelName.endsWith(key)) {
      if (!best || key.length > best.length) best = key;
    }
  }
  if (best) return classify(best, models[best]);

  return { canonical: modelName, entry: null, status: UNPRICED };
}

/** Pick the rate period covering an ISO date. Last period wins when undated. */
export function periodFor(entry, dateStr) {
  const periods = (entry && entry.periods) || [];
  if (!periods.length) return null;
  if (!dateStr) return periods[periods.length - 1];
  for (const period of periods) {
    if (period.from && dateStr < period.from) continue;
    if (period.to && dateStr > period.to) continue;
    return period;
  }
  return periods[periods.length - 1];
}

/** Base input and output rates for a model on a date at a speed. */
export function baseRates(entry, dateStr, speed) {
  const period = periodFor(entry, dateStr);
  if (!period) return { input: null, output: null };

  if (speed && speed !== 'standard') {
    const override = entry.speed && entry.speed[speed];
    if (override) return { input: override.input, output: override.output };
  }
  return { input: period.input, output: period.output };
}

// ── One turn ─────────────────────────────────────────────────

export function zeroCost() {
  return { input: 0, output: 0, cache_write: 0, cache_read: 0, total: 0 };
}

export function zeroTokens() {
  return {
    input: 0, output: 0, thinking: 0,
    cache_write_5m: 0, cache_write_1h: 0, cache_read: 0,
  };
}

/**
 * Read one record's cache-write counters into tokens.
 * @returns {boolean} true when the TTL split was missing and the flat counter
 *   had to be assumed 5-minute.
 */
function addCacheWrite(tokens, source) {
  const creation = source.cache_creation;
  const hasSplit = creation && typeof creation === 'object'
    && ('ephemeral_5m_input_tokens' in creation || 'ephemeral_1h_input_tokens' in creation);

  if (hasSplit) {
    tokens.cache_write_5m += creation.ephemeral_5m_input_tokens || 0;
    tokens.cache_write_1h += creation.ephemeral_1h_input_tokens || 0;
    return false;
  }
  // No split available. Assume 5m, the default TTL, and mark the row.
  const flat = source.cache_creation_input_tokens || 0;
  tokens.cache_write_5m += flat;
  return flat > 0;
}

/**
 * Pull the six billable counters out of a usage object.
 * Rule 3: the TTL split lives in cache_creation. A record carrying only the flat
 * counter is treated as 5m and flagged, so the page can say which totals are
 * approximate instead of pretending they are exact.
 * Rule 5: a non-empty usage.iterations replaces the top-level counters, and is
 * never added to them. See the header comment for the measurement.
 * @returns {{tokens: object, estimated: boolean, fromIterations: boolean}}
 */
export function extractTokens(usage) {
  const tokens = zeroTokens();
  if (!usage || typeof usage !== 'object') {
    return { tokens, estimated: false, fromIterations: false };
  }

  const details = usage.output_tokens_details;
  if (details && typeof details === 'object') {
    // A label only. Already inside output_tokens, never added to cost.
    tokens.thinking = details.thinking_tokens || 0;
  }

  const iterations = usage.iterations;
  if (Array.isArray(iterations) && iterations.length) {
    let estimated = false;
    for (const it of iterations) {
      if (!it || typeof it !== 'object') continue;
      tokens.input += it.input_tokens || 0;
      tokens.output += it.output_tokens || 0;
      tokens.cache_read += it.cache_read_input_tokens || 0;
      estimated = addCacheWrite(tokens, it) || estimated;
    }
    return { tokens, estimated, fromIterations: true };
  }

  tokens.input = usage.input_tokens || 0;
  tokens.output = usage.output_tokens || 0;
  tokens.cache_read = usage.cache_read_input_tokens || 0;
  const estimated = addCacheWrite(tokens, usage);

  return { tokens, estimated, fromIterations: false };
}

/**
 * Multiplier for a service tier. A tier with no published flat multiple is
 * priced at standard and reported as an assumption, not silently discounted.
 */
export function tierMultiplier(rates, tier) {
  if (!tier || tier === 'standard') return { multiplier: 1, assumed: false };
  const tiers = (rates && rates.service_tiers) || FALLBACK_TIERS;
  const entry = tiers[tier];
  if (!entry || entry.multiplier === null || entry.multiplier === undefined) {
    return { multiplier: 1, assumed: true };
  }
  return { multiplier: entry.multiplier, assumed: false };
}

/** Cost a token bundle. Returns { cost, status, tierAssumed }. */
export function priceTokens(tokens, entry, rates, dateStr, speed, tier) {
  if (!entry || !entry.periods || !entry.periods.length) {
    return { cost: zeroCost(), status: UNPRICED, tierAssumed: false };
  }

  let { input: inp, output: out } = baseRates(entry, dateStr, speed);
  if (inp === null || inp === undefined) {
    return { cost: zeroCost(), status: UNPRICED, tierAssumed: false };
  }

  const { multiplier: tierMult, assumed: tierAssumed } = tierMultiplier(rates, tier);
  inp *= tierMult;
  out *= tierMult;

  const mult = (rates && rates.multipliers) || FALLBACK_MULTIPLIERS;
  const write5m = inp * mult.cache_write_5m;
  const write1h = inp * mult.cache_write_1h;
  const read = inp * mult.cache_read;

  const cost = {
    input: (tokens.input * inp) / MILLION,
    output: (tokens.output * out) / MILLION,
    cache_write: (tokens.cache_write_5m * write5m + tokens.cache_write_1h * write1h) / MILLION,
    cache_read: (tokens.cache_read * read) / MILLION,
  };
  cost.total = cost.input + cost.output + cost.cache_write + cost.cache_read;
  return { cost, status: PRICED, tierAssumed };
}

/**
 * Cost one assistant turn.
 * @param {object} message  the transcript's message object (model + usage)
 * @param {object} rates    a releve-rates/v1 card
 * @param {string} [dateStr] ISO date, for dated price changes
 */
export function priceTurn(message, rates, dateStr) {
  const usage = (message && message.usage) || null;
  const modelName = (message && message.model) || null;
  const { tokens, estimated, fromIterations } = extractTokens(usage);
  const { canonical, entry, status } = resolveModel(modelName, rates);

  if (status === EXCLUDED) {
    return {
      model: modelName, canonical, status: EXCLUDED,
      tokens, cost: zeroCost(), estimated_cache_split: estimated,
      tier: null, tier_assumed: false, from_iterations: fromIterations,
    };
  }

  const speed = usage ? usage.speed : null;
  const tier = usage ? usage.service_tier : null;
  const priced = priceTokens(tokens, entry, rates, dateStr, speed, tier);

  return {
    model: modelName,
    canonical,
    status: status === UNPRICED ? UNPRICED : priced.status,
    tokens,
    cost: priced.cost,
    estimated_cache_split: estimated,
    tier: tier || null,
    tier_assumed: priced.tierAssumed,
    from_iterations: fromIterations,
  };
}

/**
 * The counterfactual: what this turn would have cost with no cache at all,
 * every read and write repriced as fresh input. Drives the cache lab.
 */
export function uncachedCost(tokens, entry, rates, dateStr, speed, tier) {
  if (!entry || !entry.periods || !entry.periods.length) return 0;
  let { input: inp, output: out } = baseRates(entry, dateStr, speed);
  if (inp === null || inp === undefined) return 0;
  const { multiplier } = tierMultiplier(rates, tier);
  inp *= multiplier;
  out *= multiplier;
  const fresh = tokens.input + tokens.cache_read
    + tokens.cache_write_5m + tokens.cache_write_1h;
  return (fresh * inp + tokens.output * out) / MILLION;
}

// ── Accumulation ─────────────────────────────────────────────

export function addTokens(into, more) {
  for (const key of Object.keys(into)) into[key] += more[key] || 0;
  return into;
}

export function addCost(into, more) {
  for (const key of Object.keys(into)) into[key] += more[key] || 0;
  return into;
}

/**
 * The dedup key for one *billed* API response. Mirrors turn_key() in
 * releve_cost.py.
 *
 * Claude Code writes one JSONL entry per content block of a response, and every
 * one carries the same `usage` object, so a turn that thought, spoke and called
 * a tool is three entries with three uuids and one bill. Keying on `uuid`
 * therefore dedupes nothing: measured here, 116,402 entries are 52,078
 * responses, and the per-uuid reading reports 30.02B cache-read tokens against
 * a true 12.92B. `message.id` is the API's id for the response, so it also
 * collapses the replay a resumed session writes into a second transcript.
 */
export function turnKey(entry) {
  const message = entry.message;
  if (message && message.id) return message.id;
  return entry.uuid;
}

/**
 * Every counter that can carry a charge. thinking is excluded: it is already
 * inside output. Used to pick the richest of several records for one turn.
 */
export function billableTotal(tokens) {
  return tokens.input + tokens.output + tokens.cache_read
    + tokens.cache_write_5m + tokens.cache_write_1h;
}

/**
 * A running total of turns, tokens and cost for one dimension value.
 * unpriced_turns is tracked separately so a row can never present an unpriced
 * model as costing nothing.
 */
export class Bucket {
  constructor(key) {
    this.key = key;
    this.turns = 0;
    this.unpriced_turns = 0;
    this.tokens = zeroTokens();
    this.cost = zeroCost();
    this.uncached = 0;
  }

  add(priced, uncached = 0) {
    this.turns += 1;
    if (priced.status === UNPRICED) this.unpriced_turns += 1;
    addTokens(this.tokens, priced.tokens);
    addCost(this.cost, priced.cost);
    this.uncached += uncached;
    return this;
  }
}

// ── Parity self-check ────────────────────────────────────────

/**
 * Assert this engine against data/testcases.json, the same fixture
 * scripts/test_cost.py uses. A mismatch means the browser and the scripts
 * disagree about money, which is a blocker rather than a warning: the Method
 * section surfaces the result and the console lists every failing case.
 *
 * @returns {Promise<{ok: boolean, total: number, failures: Array}>}
 */
export async function selfCheck(rates, fixtureUrl = 'data/testcases.json') {
  let fixture;
  try {
    const res = await fetch(fixtureUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fixture = await res.json();
  } catch (err) {
    return { ok: false, total: 0, failures: [{ name: '(fixture)', lines: [String(err)] }] };
  }

  const tol = fixture.tolerance || 1e-9;
  const failures = [];

  for (const c of fixture.cases) {
    const want = c.expect;
    const got = priceTurn(c.message, rates, c.date);
    const lines = [];

    if ('canonical' in want && got.canonical !== want.canonical) {
      lines.push(`canonical: expected ${want.canonical}, got ${got.canonical}`);
    }
    if ('status' in want && got.status !== want.status) {
      lines.push(`status: expected ${want.status}, got ${got.status}`);
    }
    if ('estimated_cache_split' in want
        && got.estimated_cache_split !== want.estimated_cache_split) {
      lines.push(`estimated_cache_split: expected ${want.estimated_cache_split}, got ${got.estimated_cache_split}`);
    }
    for (const flag of ['tier_assumed', 'from_iterations']) {
      if (flag in want && got[flag] !== want[flag]) {
        lines.push(`${flag}: expected ${want[flag]}, got ${got[flag]}`);
      }
    }
    for (const [key, value] of Object.entries(want.tokens || {})) {
      if (got.tokens[key] !== value) {
        lines.push(`tokens.${key}: expected ${value}, got ${got.tokens[key]}`);
      }
    }
    for (const [key, value] of Object.entries(want.cost || {})) {
      if (!(Math.abs(got.cost[key] - value) <= tol)) {
        lines.push(`cost.${key}: expected ${value}, got ${got.cost[key]}`);
      }
    }
    if ('uncached' in want) {
      const { entry } = resolveModel(c.message && c.message.model, rates);
      const u = (c.message && c.message.usage) || {};
      const have = uncachedCost(got.tokens, entry, rates, c.date, u.speed, u.service_tier);
      if (!(Math.abs(have - want.uncached) <= tol)) {
        lines.push(`uncached: expected ${want.uncached}, got ${have}`);
      }
    }

    if (lines.length) failures.push({ name: c.name, why: c.why, lines });
  }

  // Rule 6, the one that decides how many billed turns there are rather than
  // what one of them costs. Same cases the Python side asserts.
  const dedup = fixture.dedup || [];
  for (const c of dedup) {
    const got = c.entries.map((e) => turnKey(e));
    const want = c.expect.keys;
    if (got.length !== want.length || got.some((k, i) => k !== want[i])) {
      failures.push({
        name: c.name,
        why: c.why,
        lines: [`keys: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`],
      });
    }
  }

  const total = fixture.cases.length + dedup.length;
  const result = { ok: failures.length === 0, total, failures };

  if (!result.ok) {
    console.error(
      `releve: pricing engine parity FAILED, ${failures.length}/${result.total} cases. `
      + 'The browser and scripts/releve_cost.py disagree about money.',
    );
    for (const f of failures) {
      console.error(`  ${f.name}: ${f.lines.join(' · ')}`);
    }
  }

  return result;
}
