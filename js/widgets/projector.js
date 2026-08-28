// ── Section 6: Projector ─────────────────────────────────────
// What the next stretch of work costs. Every input is either a slider the
// visitor moved or a median measured in the loaded dataset, and the output says
// which. A projector fed by guesses is a random number generator with a chart.
//
// The model, in one paragraph: a turn's total input volume V is the measured
// median of fresh input plus cache reads plus cache writes for that model and
// effort. The hit-ratio slider decides how much of V is served from cache; what
// is left is split between fresh input and cache writes in the same proportion
// the dataset shows, and the writes are split between the two TTLs by the second
// slider. Output tokens come from their own median and are unaffected by caching.

import { bars, statGrid } from '../viz.js';
import { priceTokens, resolveModel, zeroTokens } from '../cost.js';
import {
  big, count, escHtml, money, money0, mult, NO_VALUE, pct, shortModel,
} from '../utils.js';

/** Model and effort pairs the dataset actually measured. A projection for a
 *  model that never ran here would be extrapolation dressed as calibration. */
export function calibrated(doc) {
  const cal = ((doc || {}).calibration || {}).tokens_per_turn || {};
  const out = [];
  for (const [model, efforts] of Object.entries(cal)) {
    for (const [effort, sample] of Object.entries(efforts)) {
      out.push({ model, effort, ...sample });
    }
  }
  out.sort((a, b) => b.turns - a.turns);
  return out;
}

/**
 * Point every slider at what the loaded dataset actually measured. Called on
 * load and by "Reset to measured", so the projector's starting position is a
 * description of history rather than a set of round numbers.
 */
export function seed(s) {
  const rows = calibrated(s.doc);
  if (rows.length) {
    s.proj.model = rows[0].model;
    s.proj.effort = rows[0].effort;
  }
  const cal = (s.doc || {}).calibration || {};
  if (cal.cache_hit_ratio != null) s.proj.hitRatio = cal.cache_hit_ratio;
  const perSession = (cal.turns_per_session || {}).p50;
  if (perSession) s.proj.turnsPerIteration = Math.max(1, Math.round(perSession));
  const tk = ((s.doc || {}).totals || {}).tokens;
  if (tk) {
    const writes = (tk.cache_write_5m || 0) + (tk.cache_write_1h || 0);
    if (writes) s.proj.ttl1hShare = (tk.cache_write_1h || 0) / writes;
  }
  return s.proj;
}

export function options(state) {
  const rows = calibrated(state.doc);
  const models = [...new Set(rows.map((r) => r.model))];
  const efforts = [...new Set(rows.filter((r) => r.model === state.proj.model)
    .map((r) => r.effort))];
  return {
    models: models.map((m) => `<option value="${escHtml(m)}"${m === state.proj.model
      ? ' selected' : ''}>${escHtml(shortModel(m))}</option>`).join(''),
    efforts: efforts.map((e) => `<option value="${escHtml(e)}"${e === state.proj.effort
      ? ' selected' : ''}>${escHtml(e)}</option>`).join(''),
  };
}

/** The measured sample for the current selection, or the largest one available. */
export function sampleFor(state) {
  const rows = calibrated(state.doc);
  if (!rows.length) return null;
  return rows.find((r) => r.model === state.proj.model && r.effort === state.proj.effort)
    || rows.find((r) => r.model === state.proj.model)
    || rows[0];
}

/** One projection. Pure: same inputs, same number, so the sensitivity sweep can
 *  call it repeatedly with perturbed inputs. */
export function project(state, rates, proj = state.proj) {
  const sample = sampleFor({ ...state, proj });
  if (!sample) return null;

  const input = sample.input_p50 || 0;
  const read = sample.cache_read_p50 || 0;
  const write = sample.cache_write_p50 || 0;
  const volume = input + read + write;
  const freshShare = (input + write) ? input / (input + write) : 1;

  const turns = Math.max(1, Math.round(proj.iterations * proj.turnsPerIteration));
  const cached = volume * proj.hitRatio;
  const rest = volume - cached;

  const perTurn = zeroTokens();
  perTurn.input = rest * freshShare;
  const writeTokens = rest * (1 - freshShare);
  perTurn.cache_write_1h = writeTokens * proj.ttl1hShare;
  perTurn.cache_write_5m = writeTokens - perTurn.cache_write_1h;
  perTurn.cache_read = cached;
  perTurn.output = sample.output_p50 || 0;

  const tokens = zeroTokens();
  for (const key of Object.keys(tokens)) tokens[key] = perTurn[key] * turns;

  const { entry, status } = resolveModel(sample.model, rates);
  const priced = priceTokens(tokens, entry, rates, null, null, null);
  const perTurnPriced = priceTokens(perTurn, entry, rates, null, null, null);

  return {
    sample, turns, volume, tokens, perTurn,
    cost: priced.cost,
    costPerTurn: perTurnPriced.cost.total,
    status: status === 'excluded' ? 'excluded' : priced.status,
  };
}

export function output(state, view, p) {
  if (!p) {
    return '<div class="viz-panel"><div class="viz-empty">This dataset carries no '
      + 'per-turn medians, so there is nothing to project from.</div></div>';
  }
  if (p.status !== 'priced') {
    return '<div class="note note--warn"><p><strong>'
      + escHtml(shortModel(p.sample.model)) + '</strong> has no published rate, so '
      + 'this projection can report tokens but not dollars. Pick another model.</p></div>';
  }

  const months = state.planCost ? p.cost.total / state.planCost : null;
  const total = p.tokens.input + p.tokens.output + p.tokens.cache_read
    + p.tokens.cache_write_5m + p.tokens.cache_write_1h;

  return statGrid([
    { label: 'API-equivalent', value: money0(p.cost.total) },
    { label: 'Per turn', value: money(p.costPerTurn) },
    { label: 'Months of plan', value: months == null ? NO_VALUE : mult(months) },
    { label: 'Tokens', value: big(total) },
  ]);
}

/**
 * Which lever actually moves the bill. Each is nudged by a realistic amount, not
 * by a uniform percentage, so the ranking answers "what should I change?"
 * rather than "which input has the largest units?".
 */
const LEVERS = [
  {
    label: '10% more iterations',
    apply: (p) => ({ ...p, iterations: p.iterations * 1.1 }),
  },
  {
    label: '10% longer iterations',
    apply: (p) => ({ ...p, turnsPerIteration: p.turnsPerIteration * 1.1 }),
  },
  {
    label: 'Cache hit ratio 1 point lower',
    apply: (p) => ({ ...p, hitRatio: Math.max(0, p.hitRatio - 0.01) }),
  },
  {
    label: 'All writes at the 1-hour TTL',
    apply: (p) => ({ ...p, ttl1hShare: 1 }),
  },
  {
    label: 'All writes at the 5-minute TTL',
    apply: (p) => ({ ...p, ttl1hShare: 0 }),
  },
];

export function sensitivity(state, view, p) {
  if (!p || p.status !== 'priced') return '';
  const baseline = p.cost.total;
  if (!baseline) return '';

  const rows = LEVERS.map((lever) => {
    const alt = project(state, view.rates, lever.apply(state.proj));
    return { label: lever.label, delta: alt ? alt.cost.total - baseline : 0 };
  }).filter((r) => Math.abs(r.delta) > baseline * 1e-6);
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const chart = bars(rows.map((r) => ({
    label: r.delta > 0 ? `+${money0(r.delta)}` : money0(r.delta),
    value: Math.abs(r.delta),
    color: r.delta > 0 ? 'var(--viz-c3)' : 'var(--viz-c2)',
  })), {
    width: 380,
    height: 150,
    title: 'What moves the number',
    scale: `against ${money0(baseline)}`,
    ariaLabel: 'Effect of each lever on the projected cost',
  });

  const list = rows.map((r) => `<div><dt>${escHtml(r.label)}</dt>`
    + `<dd><span class="num ${r.delta > 0 ? 'num--money' : 'num--good'}">`
    + `${r.delta > 0 ? '+' : ''}${escHtml(money(r.delta))}</span> `
    + `<span class="num--muted">${escHtml(pct(r.delta / baseline))}</span></dd></div>`).join('');

  return `${chart}<dl class="deflist">${list}</dl>`;
}

export function note(state, view, p) {
  if (!p) return '';
  const s = p.sample;
  const cal = (state.doc.calibration || {}).turns_per_session || {};
  const measured = (state.doc.calibration || {}).cache_hit_ratio;
  return `<p>Medians for <code>${escHtml(shortModel(s.model))}</code> at effort `
    + `<code>${escHtml(s.effort)}</code>, measured over ${count(s.turns)} real turns: `
    + `${count(s.input_p50)} fresh input, ${count(s.cache_read_p50)} cache read, `
    + `${count(s.cache_write_p50)} cache write and ${count(s.output_p50)} output per `
    + `turn, so ${big(p.volume)} tokens of context per turn. The 90th percentile of `
    + `output is ${count(s.output_p90)}, roughly `
    + `${s.output_p50 ? mult(s.output_p90 / s.output_p50) : NO_VALUE} the median: a long `
    + 'turn costs more than this projection assumes.</p>'
    + `<p>Sessions in this dataset ran ${count(cal.p50)} turns at the median and `
    + `${count(cal.p90)} at the 90th percentile, and ${pct(measured)} of input was `
    + 'served from cache. Those are the numbers the sliders start from; move them '
    + 'and the projection stops describing measured history.</p>';
}
