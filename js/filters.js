// ── Filters and repricing ────────────────────────────────────
// One function, buildView(), turns the loaded document plus the visitor's
// filters and rate edits into everything the widgets draw. Nothing else
// aggregates or reprices.
//
// Two design constraints, both worth stating because they shape the UI:
//
// 1. **Date window plus at most one facet.** The document holds aggregates, not
//    turns, so "project X and model Y" is a number nobody wrote down. Rather
//    than invent an intersection, the page offers a window and one facet, and
//    says so.
//
// 2. **Repricing is exact by some paths and approximate by others.** With no
//    rate edits every figure is the scanner's own, computed per turn at that
//    turn's own date, so it is exact everywhere. Edit a rate and the page must
//    reprice pre-aggregated tokens: exact when a bucket's whole token mix is
//    known (the window, any model, any facet over the full window), blended
//    when only a facet's per-day cost is known. Blended cases are flagged, not
//    quietly rounded.

import {
  UNPRICED,
  addCost, addTokens, priceTokens, resolveModel, uncachedCost,
  zeroCost, zeroTokens,
} from './cost.js';
import { effectiveRates } from './rates.js';
import { hasRateEdits } from './state.js';

const DAY_MS = 86400000;
const MONTH_DAYS = 30.4375;   // mean Gregorian month, for pro-rating a plan

// ── Rate mix ─────────────────────────────────────────────────

/**
 * model -> the rate keys it spent under, with their token totals.
 * A model normally has exactly one, and then repricing is exact. A model that
 * ran some turns in fast mode or on a batch tier has several, and a day's slice
 * of it is split across them in proportion to the window, which is the one
 * approximation this file makes without saying so per row (it moves a total by
 * fractions of a percent, and only under an edited rate).
 */
function rateMix(doc) {
  const meta = doc.rate_keys || {};
  const mix = new Map();
  for (const row of (doc.dimensions && doc.dimensions.model) || []) {
    const keys = [];
    for (const [key, tokens] of Object.entries(row.by_rate || {})) {
      keys.push({ key, meta: meta[key] || { model: row.key, speed: 'standard', tier: 'standard' }, tokens });
    }
    mix.set(row.key, keys);
  }
  return mix;
}

const CLASSES = ['input', 'output', 'thinking', 'cache_write_5m', 'cache_write_1h', 'cache_read'];

function scaleTokens(tokens, fracs) {
  const out = zeroTokens();
  for (const cls of CLASSES) out[cls] = (tokens[cls] || 0) * (fracs[cls] || 0);
  return out;
}

/** Price a token bundle known to belong to one model, on one date. */
function priceModelTokens(model, tokens, mix, rates, date) {
  const keys = mix.get(model);
  const cost = zeroCost();

  if (!keys || !keys.length) {
    const { entry } = resolveModel(model, rates);
    const p = priceTokens(tokens, entry, rates, date, null, null);
    return { cost: p.cost, status: p.status };
  }

  if (keys.length === 1) {
    const { meta } = keys[0];
    const { entry } = resolveModel(meta.model, rates);
    const p = priceTokens(tokens, entry, rates, date, meta.speed, meta.tier);
    return { cost: p.cost, status: p.status };
  }

  // Several rate keys. Split each token class across them in the proportion the
  // whole window shows, which is the same thing as pricing at a blended rate.
  const totals = {};
  for (const cls of CLASSES) {
    totals[cls] = keys.reduce((sum, k) => sum + (k.tokens[cls] || 0), 0);
  }
  let status = null;
  for (const { meta, tokens: kt } of keys) {
    const fracs = {};
    for (const cls of CLASSES) fracs[cls] = totals[cls] ? (kt[cls] || 0) / totals[cls] : 0;
    const { entry } = resolveModel(meta.model, rates);
    const p = priceTokens(scaleTokens(tokens, fracs), entry, rates, date, meta.speed, meta.tier);
    addCost(cost, p.cost);
    if (p.status === UNPRICED) status = UNPRICED;
  }
  return { cost, status };
}

/** The same, for the no-cache counterfactual. */
function uncachedModelTokens(model, tokens, mix, rates, date) {
  const keys = mix.get(model);
  if (!keys || !keys.length) {
    const { entry } = resolveModel(model, rates);
    return uncachedCost(tokens, entry, rates, date, null, null);
  }
  if (keys.length === 1) {
    const { meta } = keys[0];
    const { entry } = resolveModel(meta.model, rates);
    return uncachedCost(tokens, entry, rates, date, meta.speed, meta.tier);
  }
  const totals = {};
  for (const cls of CLASSES) {
    totals[cls] = keys.reduce((sum, k) => sum + (k.tokens[cls] || 0), 0);
  }
  let sum = 0;
  for (const { meta, tokens: kt } of keys) {
    const fracs = {};
    for (const cls of CLASSES) fracs[cls] = totals[cls] ? (kt[cls] || 0) / totals[cls] : 0;
    const { entry } = resolveModel(meta.model, rates);
    sum += uncachedCost(scaleTokens(tokens, fracs), entry, rates, date, meta.speed, meta.tier);
  }
  return sum;
}

/**
 * Reprice a dimension bucket exactly, from its by_rate cross-tab.
 * This is why the scanner writes by_rate: a project's bill depends on which
 * models spent it, so no bucket can be repriced from its own total.
 */
function repriceBucket(row, doc, rates, date) {
  const meta = doc.rate_keys || {};
  const cost = zeroCost();
  let unpriced = false;
  for (const [key, tokens] of Object.entries(row.by_rate || {})) {
    const m = meta[key] || { model: key, speed: 'standard', tier: 'standard' };
    const { entry } = resolveModel(m.model, rates);
    const p = priceTokens(tokens, entry, rates, date, m.speed, m.tier);
    addCost(cost, p.cost);
    if (p.status === UNPRICED) unpriced = true;
  }
  return { cost, unpriced };
}

// ── Buckets on the time axis ─────────────────────────────────

function weekStart(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const shift = (d.getUTCDay() + 6) % 7;   // Monday = 0
  return new Date(d.getTime() - shift * DAY_MS).toISOString().slice(0, 10);
}

function bucketKey(iso, bucket) {
  if (bucket === 'month') return iso.slice(0, 7);
  if (bucket === 'week') return weekStart(iso);
  return iso;
}

function daysBetween(from, to) {
  if (!from || !to) return 0;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

// ── The view ─────────────────────────────────────────────────

/**
 * Everything the page draws, derived fresh on every change.
 * Cheap enough to do so: 79 days by 8 dimensions is a few thousand objects,
 * and doing it any other way means two sources of truth for one number.
 */
export function buildView(state) {
  const doc = state.doc;
  const rates = effectiveRates(state.baseRates, state.rateOverrides);
  const edited = hasRateEdits(state);
  const mix = rateMix(doc);
  const notes = [];

  const allDays = doc.days || [];
  const allFrom = allDays.length ? allDays[0].date : null;
  const allTo = allDays.length ? allDays[allDays.length - 1].date : null;
  const from = state.filters.from || allFrom;
  const to = state.filters.to || allTo;
  const full = from === allFrom && to === allTo;
  const days = allDays.filter((d) => d.date >= from && d.date <= to);
  const asOf = to || allTo;

  const facet = state.filters.facet;
  const facetIsModel = facet && facet.name === 'model';

  // ── Per-day slices, honouring the facet ──
  // Each day yields its own cost, so a dated price change is applied on the day
  // it applied, not at the window's end.
  const perDay = [];
  const totals = {
    turns: 0, unpriced_turns: 0, tokens: zeroTokens(), cost: zeroCost(), uncached: 0,
  };
  let facetScale = 1;
  let daySlicesExact = true;

  if (facet && !facetIsModel) {
    // days[].dims carries cost but not tokens, so a facet inside a sub-window is
    // scaled by that facet's own window-wide reprice factor. Exact when no rate
    // is edited (the factor is 1), blended when one is.
    const row = ((doc.dimensions || {})[facet.name] || []).find((r) => r.key === facet.key);
    if (row && edited) {
      const before = row.cost.total;
      const after = repriceBucket(row, doc, rates, asOf).cost.total;
      facetScale = before ? after / before : 1;
      daySlicesExact = false;
    }
  }

  for (const day of days) {
    const entry = { date: day.date, turns: 0, unpriced_turns: 0, cost: 0, uncached: 0 };
    const byModel = {};

    if (!facet) {
      entry.turns = day.turns;
      entry.unpriced_turns = day.unpriced_turns;
      addTokens(totals.tokens, day.tokens);
      for (const [model, bucket] of Object.entries(day.by_model || {})) {
        // Cost components, not just the total: the cache lab breaks the window
        // down by input / output / write / read.
        const cost = edited
          ? priceModelTokens(model, bucket.tokens, mix, rates, day.date).cost
          : bucket.cost;
        const unc = edited
          ? uncachedModelTokens(model, bucket.tokens, mix, rates, day.date)
          : bucket.uncached_cost;
        addCost(totals.cost, cost);
        byModel[model] = cost.total;
        entry.cost += cost.total;
        entry.uncached += unc;
      }
    } else if (facetIsModel) {
      const bucket = (day.by_model || {})[facet.key];
      if (bucket) {
        entry.turns = bucket.turns;
        entry.unpriced_turns = bucket.unpriced_turns;
        addTokens(totals.tokens, bucket.tokens);
        const priced = edited
          ? priceModelTokens(facet.key, bucket.tokens, mix, rates, day.date).cost
          : bucket.cost;
        addCost(totals.cost, priced);
        entry.cost = priced.total;
        entry.uncached = edited
          ? uncachedModelTokens(facet.key, bucket.tokens, mix, rates, day.date)
          : bucket.uncached_cost;
        byModel[facet.key] = entry.cost;
      }
    } else {
      const cell = ((day.dims || {})[facet.name] || {})[facet.key];
      if (cell) {
        entry.turns = cell[0];
        entry.cost = cell[1] * facetScale;
        entry.unpriced_turns = cell[2];
        byModel[facet.key] = entry.cost;
      }
    }

    entry.byModel = byModel;
    totals.turns += entry.turns;
    totals.unpriced_turns += entry.unpriced_turns;
    totals.uncached += entry.uncached;
    perDay.push(entry);
  }

  if (facet && !facetIsModel) {
    // Cost came from days[].dims, and its token breakdown was not recorded there.
    // Take the tokens from the window-wide bucket, scaled by how much of the
    // facet's turns fall inside the window, and say so.
    const row = ((doc.dimensions || {})[facet.name] || []).find((r) => r.key === facet.key);
    if (row) {
      const share = row.turns ? totals.turns / row.turns : 0;
      for (const cls of CLASSES) totals.tokens[cls] = (row.tokens[cls] || 0) * share;
      totals.cost = zeroCost();
      const scale = row.cost.total ? (perDay.reduce((s, d) => s + d.cost, 0) / row.cost.total) : 0;
      for (const key of Object.keys(totals.cost)) totals.cost[key] = (row.cost[key] || 0) * scale;
      totals.uncached = row.uncached_cost * share;
      if (!full) {
        notes.push(
          `Token and cache figures for ${facet.key} are the window's share of its `
          + `${row.turns.toLocaleString()} turns, pro-rated by turn count. `
          + 'Costs and turn counts are per day and exact; the token split is not.',
        );
      }
      if (edited) {
        notes.push(
          `Rate edits are applied to ${facet.key} as one blended factor `
          + `(x${facetScale.toFixed(4)}) taken from its model mix over the full window.`,
        );
      }
    }
  }

  // ── Time series, bucketed ──
  const bucket = state.view.bucket;
  const seriesMap = new Map();
  for (const day of perDay) {
    const key = bucketKey(day.date, bucket);
    let slot = seriesMap.get(key);
    if (!slot) {
      // from/to are the bucket's own date range, so clicking a week-wide bar can
      // narrow the window to exactly that week without re-deriving the grouping.
      slot = { key, date: day.date, from: day.date, to: day.date, turns: 0, cost: 0, uncached: 0, byModel: {} };
      seriesMap.set(key, slot);
    }
    slot.to = day.date;
    slot.turns += day.turns;
    slot.cost += day.cost;
    slot.uncached += day.uncached;
    for (const [model, cost] of Object.entries(day.byModel)) {
      slot.byModel[model] = (slot.byModel[model] || 0) + cost;
    }
  }
  const series = [...seriesMap.values()];

  // Stack order: biggest spender at the bottom, stable across buckets.
  const modelTotals = new Map();
  for (const slot of series) {
    for (const [model, cost] of Object.entries(slot.byModel)) {
      modelTotals.set(model, (modelTotals.get(model) || 0) + cost);
    }
  }
  const models = [...modelTotals.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);

  // ── The active breakdown ──
  const dimName = state.view.dim;
  const dimRows = (doc.dimensions || {})[dimName] || [];
  let rows;
  let rowsExact = true;

  if (full) {
    rows = dimRows.map((row) => {
      const cost = edited ? repriceBucket(row, doc, rates, asOf).cost : row.cost;
      return {
        key: row.key,
        turns: row.turns,
        unpriced_turns: row.unpriced_turns,
        tokens: row.tokens,
        cost,
        uncached: row.uncached_cost,
      };
    });
  } else if (dimName === 'model') {
    // Sum the window's own days: exact, including dated price changes.
    const acc = new Map();
    for (const day of days) {
      for (const [model, b] of Object.entries(day.by_model || {})) {
        let slot = acc.get(model);
        if (!slot) {
          slot = { key: model, turns: 0, unpriced_turns: 0, tokens: zeroTokens(), cost: zeroCost(), uncached: 0 };
          acc.set(model, slot);
        }
        slot.turns += b.turns;
        slot.unpriced_turns += b.unpriced_turns;
        addTokens(slot.tokens, b.tokens);
        addCost(slot.cost, edited
          ? priceModelTokens(model, b.tokens, mix, rates, day.date).cost
          : b.cost);
        slot.uncached += edited
          ? uncachedModelTokens(model, b.tokens, mix, rates, day.date)
          : b.uncached_cost;
      }
    }
    rows = [...acc.values()];
  } else {
    // Per-day dimension slices: turns and cost only.
    const acc = new Map();
    for (const day of days) {
      for (const [key, cell] of Object.entries((day.dims || {})[dimName] || {})) {
        let slot = acc.get(key);
        if (!slot) {
          slot = { key, turns: 0, unpriced_turns: 0, tokens: null, cost: zeroCost(), uncached: 0 };
          acc.set(key, slot);
        }
        slot.turns += cell[0];
        slot.cost.total += cell[1];
        slot.unpriced_turns += cell[2];
      }
    }
    rows = [...acc.values()];
    if (edited) {
      const byKey = new Map(dimRows.map((r) => [r.key, r]));
      for (const slot of rows) {
        const row = byKey.get(slot.key);
        if (!row || !row.cost.total) continue;
        slot.cost.total *= repriceBucket(row, doc, rates, asOf).cost.total / row.cost.total;
      }
      rowsExact = false;
    }
  }

  // Facet selection dims the rest rather than removing it: seeing a slice next
  // to what it is a slice of is the point.
  const rowTotal = rows.reduce((s, r) => s + r.cost.total, 0);
  for (const row of rows) {
    row.share = rowTotal ? row.cost.total / rowTotal : 0;
    row.picked = !!(facet && facet.name === dimName && facet.key === row.key);
  }
  sortRows(rows, state.view.sort, state.view.dir);

  // ── Cache lab ──
  const tk = totals.tokens;
  const cachedIn = tk.cache_read;
  const freshIn = tk.input + tk.cache_write_5m + tk.cache_write_1h;
  const cache = {
    tokens: tk,
    cost: totals.cost,
    uncached: totals.uncached,
    saved: totals.uncached - totals.cost.total,
    multiple: totals.cost.total ? totals.uncached / totals.cost.total : null,
    hitRatio: (cachedIn + freshIn) ? cachedIn / (cachedIn + freshIn) : null,
    ratioSeries: perDay.map((d) => ({ date: d.date, cost: d.cost, uncached: d.uncached })),
  };

  // ── Plan comparison ──
  const windowDays = daysBetween(from, to);
  const prorated = state.planCost * (windowDays / MONTH_DAYS);
  const plan = {
    monthly: state.planCost,
    windowDays,
    prorated,
    multiple: prorated ? totals.cost.total / prorated : null,
    perDay: windowDays ? totals.cost.total / windowDays : 0,
  };

  return {
    rates,
    edited,
    window: { from, to, allFrom, allTo, full, days: windowDays, observed: days.length },
    facet,
    exact: !edited || (rowsExact && daySlicesExact),
    notes,
    totals,
    perDay,
    series,
    bucket,
    models,
    dim: dimName,
    rows,
    rowsExact,
    sortKey: state.view.sort,
    sortDir: state.view.dir,
    cache,
    plan,
    unpriced: (doc.totals || {}).unpriced || null,
    excluded: (doc.totals || {}).excluded || null,
    quality: (doc.totals || {}).quality || null,
  };
}

/** Sort a breakdown. Unpriced rows sort by turns even in a cost sort: they have
 *  no cost, and ranking them at zero would read as "cheap". */
export function sortRows(rows, sort, dir) {
  const sign = dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    let d;
    if (sort === 'key') d = String(a.key).localeCompare(String(b.key));
    else if (sort === 'turns') d = a.turns - b.turns;
    else if (sort === 'tokens') d = totalTokens(a) - totalTokens(b);
    else d = a.cost.total - b.cost.total;
    if (d === 0) d = a.turns - b.turns;
    return d * sign;
  });
  return rows;
}

function totalTokens(row) {
  if (!row.tokens) return 0;
  return row.tokens.input + row.tokens.output + row.tokens.cache_read
    + row.tokens.cache_write_5m + row.tokens.cache_write_1h;
}

/** The presets the timeline offers. null means the whole dataset. */
export const WINDOWS = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'All', days: null },
];

/** Resolve a preset against the dataset's own last day, not today: a dataset
 *  scanned last week should still show its final seven days. */
export function presetWindow(doc, days) {
  const all = doc.days || [];
  if (!all.length) return { from: null, to: null };
  const last = all[all.length - 1].date;
  if (!days) return { from: null, to: null };
  const fromMs = Date.parse(`${last}T00:00:00Z`) - (days - 1) * DAY_MS;
  const from = new Date(fromMs).toISOString().slice(0, 10);
  return { from: from > all[0].date ? from : null, to: null };
}
