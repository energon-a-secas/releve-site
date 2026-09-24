// ── The report document ──────────────────────────────────────
// What the printable statement says, section by section. Its sibling
// js/report.js decides when it is built and hands it to the print pipeline.
//
// The split is the one render.js and widgets/ already use on the page: an
// orchestrator that owns the lifecycle, and the builders that own the content.
// Every function here returns an HTML string and touches no DOM.
//
// Each builder takes the same derived view the page's own sections are built
// from, so a figure in the PDF and the figure above it on screen cannot
// disagree. Charts are Viz Kit builders for the same reason the page's are.
//
// A section with nothing to report returns an empty string rather than an
// empty frame: a window with no turns should be a shorter document, not a
// document full of zeros.

import { bars, donut, statGrid } from './viz.js';
import { DIMS } from './state.js';
import { modelsInPlay, publishedPair } from './rates.js';
import {
  big, count, escHtml, money, money0, mult, pct, shortDate,
} from './utils.js';

/** The whole report, as one HTML string. */
export function buildDocument(state, view) {
  return masthead(state, view)
    + figures(view)
    + caveats(view)
    + timelinePart(view)
    + breakdownPart(view)
    + cachePart(view)
    + ratesPart(state, view)
    + methodPart(state, view)
    + colophon(state, view);
}

const SOURCE_TAGS = {
  demo: 'Synthetic demonstration data',
  local: 'Your own transcripts',
  file: 'A loaded scan',
  jsonl: 'A single transcript',
};

function masthead(state, view) {
  const w = view.window;
  const range = w.from === w.to
    ? longDate(w.from)
    : `${longDate(w.from)} to ${longDate(w.to)}`;
  const source = state.source || {};
  const tag = SOURCE_TAGS[source.kind] || source.kind || 'Unknown source';

  const scope = [];
  if (view.facet) {
    const dim = DIMS.find((d) => d.name === view.facet.name);
    scope.push(`${(dim && dim.label) || view.facet.name}: ${view.facet.key}`);
  }
  if (view.edited) scope.push('edited rate card');

  return `<header class="report__masthead">
    <div class="report__brand">
      <span class="report__wordmark">Releve</span>
      <span class="report__kicker">Claude Code spend, read off the transcripts</span>
    </div>
    <h1 class="report__title">Statement</h1>
    <p class="report__range">${escHtml(range)}</p>
    <dl class="report__meta">
      <div><dt>Dataset</dt><dd>${escHtml(tag)}</dd></div>
      <div><dt>Days with turns</dt><dd>${escHtml(count(w.observed))} of ${escHtml(count(w.days))}</dd></div>
      <div><dt>Scope</dt><dd>${scope.length ? escHtml(scope.join(' · ')) : 'The whole dataset'}</dd></div>
      <div><dt>Prepared</dt><dd>${escHtml(stamp())}</dd></div>
    </dl>
    <p class="report__standfirst">
      Every dollar below is token counts multiplied by a published list rate. It
      is what this work would have cost through the API, which is not what a
      subscription charged and not what any invoice says. ${view.edited
    ? '<strong>Rates on this report have been edited away from the published card</strong>, so the figures are hypothetical twice over.'
    : `Rates are the published card, last checked against the pricing page on ${escHtml(dateOf(state))}.`}
    </p>
  </header>`;
}

function figures(view) {
  const t = view.totals;
  const p = view.plan;
  const tokens = sumTokens(t.tokens);

  const cells = [
    {
      lead: true,
      label: 'API-equivalent, at list rates',
      value: money0(t.cost.total),
      foot: `${count(t.turns)} turns${t.unpriced_turns
        ? `, and ${count(t.unpriced_turns)} unpriced turns that are not in this figure` : ''}`,
    },
    {
      label: `Plan cost, ${count(p.windowDays)} days of $${count(p.monthly)}/mo`,
      value: money0(p.prorated),
      foot: 'The subscription figure entered on the page, pro-rated by calendar days',
    },
    {
      label: 'Ratio',
      value: mult(p.multiple),
      foot: p.multiple != null
        ? `${money(p.perDay)} of API-equivalent work per day`
        : 'No plan cost set',
    },
    {
      label: 'Billable tokens',
      value: big(tokens),
      foot: `${pct(view.cache.hitRatio)} of input served from cache`,
    },
  ];

  return `<section class="report__figures">${cells.map((c) => `
    <div class="report__figure${c.lead ? ' report__figure--lead' : ''}">
      <span class="report__figure-label">${escHtml(c.label)}</span>
      <span class="report__figure-value">${escHtml(c.value)}</span>
      <span class="report__figure-foot">${escHtml(c.foot)}</span>
    </div>`).join('')}</section>`;
}

/** Counted, not priced. These travel with the total or the total is a lie. */
function caveats(view) {
  const rows = [];
  const u = view.unpriced;
  if (u && u.turns) {
    rows.push([
      'Unpriced', `${count(u.turns)} turns`,
      `${(u.models || []).map((m) => m.model).join(', ')}: no published rate, so `
      + `${big(sumTokens(u.tokens))} tokens are counted and left out of every dollar `
      + 'figure above. They are not priced at a similar model\'s rate and not treated as free.',
    ]);
  }
  const e = view.excluded;
  if (e && e.turns) {
    rows.push(['Excluded', `${count(e.turns)} turns`,
      'Generated locally without an API call, so never billed by anyone.']);
  }
  const q = view.quality;
  if (q && q.estimated_cache_split_turns) {
    rows.push(['Approximate', `${count(q.estimated_cache_split_turns)} turns`,
      'Recorded only a flat cache-write counter, so the five-minute TTL was assumed. '
      + 'A one-hour write would have cost 60% more on those turns.']);
  }
  if (!view.exact) {
    rows.push(['Blended', 'some rows',
      'Part of this view is repriced from pre-aggregated tokens rather than per turn. '
      + 'The breakdown note on the page names which.']);
  }
  if (!rows.length) return '';

  return `<section class="report__block report__caveats">
    <h2>What is counted but not priced</h2>
    <dl class="report__deflist">${rows.map(([dt, n, dd]) => `
      <div><dt>${escHtml(dt)} <span class="report__num">${escHtml(n)}</span></dt>
      <dd>${escHtml(dd)}</dd></div>`).join('')}</dl>
  </section>`;
}

function timelinePart(view) {
  const { series, models, bucket } = view;
  if (!series.length) return '';

  const data = series.map((slot) => ({
    label: bucketLabel(slot.key, bucket),
    value: models.map((m) => slot.byModel[m] || 0),
  }));

  const per = view.perDay;
  const costs = per.map((d) => d.cost);
  const peak = per.length ? per.reduce((a, b) => (b.cost > a.cost ? b : a), per[0]) : null;
  const active = per.filter((d) => d.turns > 0).length;
  const mean = active ? costs.reduce((a, b) => a + b, 0) / active : 0;
  const driver = peak && Object.entries(peak.byModel || {}).sort((a, b) => b[1] - a[1])[0];
  const driverNote = driver && driver[1] > peak.cost / 2
    ? `, mostly ${driver[0].replace(/^claude-/, '')}`
    : '';

  const legend = models.map((m, i) => `<span class="report__key">`
    + `<i style="background:var(--viz-c${(i % 8) + 1})"></i>${escHtml(m.replace(/^claude-/, ''))}</span>`).join('');

  return `<section class="report__block">
    <h2>Cost over time</h2>
    ${bars(data, {
    width: 760, height: 230, padL: 44, padR: 8,
    keys: models,
    title: `Cost per ${bucket}`,
    scale: money0(view.totals.cost.total),
    ariaLabel: `Cost per ${bucket}, stacked by model`,
    animate: false,
  })}
    <div class="report__legend">${legend}</div>
    ${statGrid([
    { label: 'Per active day', value: money0(mean) },
    { label: 'Peak day', value: peak ? money0(peak.cost) : '0' },
    { label: 'Turns per active day', value: active ? count(Math.round(view.totals.turns / active)) : '0' },
    { label: 'Days with turns', value: count(active) },
  ])}
    ${peak ? `<p class="report__note">${escHtml(shortDate(peak.date))} was the peak at `
    + `${escHtml(money0(peak.cost))}${escHtml(driverNote)}. A bill is usually one or two `
    + 'days of unusual work rather than a level rate, which is what the shape above is for.</p>' : ''}
  </section>`;
}

function breakdownPart(view) {
  if (!view.rows.length) return '';
  const dim = DIMS.find((d) => d.name === view.dim);
  const label = (dim && dim.label) || view.dim;
  const maxShare = view.rows.reduce((m, r) => Math.max(m, r.share), 0) || 1;

  const body = view.rows.map((r) => {
    const allUnpriced = r.turns > 0 && r.unpriced_turns === r.turns;
    const cost = allUnpriced
      ? '<span class="report__unknown">unpriced</span>'
      : escHtml(money(r.cost.total))
        + (r.unpriced_turns ? ' <span class="report__unknown">+?</span>' : '');
    const tokens = r.tokens ? escHtml(big(sumTokens(r.tokens))) : '<span class="report__unknown">none</span>';
    return `<tr>
      <td class="report__cell-key">${escHtml(r.key)}</td>
      <td class="n">${cost}</td>
      <td class="n">${escHtml(count(r.turns))}</td>
      <td class="n">${tokens}</td>
      <td class="n">${escHtml(pct(r.share))}</td>
      <td class="report__cell-bar"><i style="width:${(r.share / maxShare * 100).toFixed(1)}%"></i></td>
    </tr>`;
  }).join('');

  const priced = view.rows.filter((r) => r.cost.total > 0).slice(0, 12);
  const chart = priced.length ? bars(priced.map((r) => ({
    label: shortKey(r.key), value: r.cost.total,
  })), {
    width: 760, height: 210, padL: 44, padR: 8,
    title: `Cost by ${label}`,
    scale: priced.length < view.rows.length
      ? `top ${priced.length} of ${view.rows.length}`
      : `${view.rows.length} in total`,
    ariaLabel: `Cost by ${label}`,
    animate: false,
  }) : '';

  return `<section class="report__block report__block--break">
    <h2>Cost by ${escHtml(label.toLowerCase())}</h2>
    ${chart}
    <table class="report__table">
      <thead><tr>
        <th>${escHtml(label)}</th><th class="n">Cost</th><th class="n">Turns</th>
        <th class="n">Tokens</th><th class="n">Share</th><th></th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
    ${view.rowsExact ? '' : '<p class="report__note">Costs in this cut are the '
    + 'window\'s own per-day figures scaled by the edited rate card, blended over '
    + 'each row\'s model mix. A row that used one model is exact; a row that mixed '
    + 'models is within a fraction of a percent.</p>'}
  </section>`;
}

function cachePart(view) {
  const c = view.cache;
  if (!c.cost.total) return '';
  const tk = c.tokens;
  const readShare = c.cost.cache_read / c.cost.total;
  const writeShare = c.cost.cache_write / c.cost.total;

  const mults = (view.rates && view.rates.multipliers) || { cache_write_5m: 1.25, cache_write_1h: 2 };
  const w5 = tk.cache_write_5m * mults.cache_write_5m;
  const w1 = tk.cache_write_1h * mults.cache_write_1h;
  const wUnits = w5 + w1;
  const classes = [
    ['Fresh input', tk.input, c.cost.input, 'Read by the model and not cached. Base rate.'],
    ['Cache write, 5 min', tk.cache_write_5m, wUnits ? c.cost.cache_write * (w5 / wUnits) : 0, '1.25x base input. The default TTL.'],
    ['Cache write, 1 hour', tk.cache_write_1h, wUnits ? c.cost.cache_write * (w1 / wUnits) : 0, '2x base input.'],
    ['Cache read', tk.cache_read, c.cost.cache_read, '0.1x base input. Where the saving is.'],
    ['Output', tk.output, c.cost.output, 'Includes thinking tokens, already inside this count.'],
  ];

  const rows = classes.map(([name, tokens, dollars, note]) => {
    const rate = tokens ? (dollars / tokens) * 1e6 : null;
    return `<tr>
      <td>${escHtml(name)}</td>
      <td class="n">${escHtml(big(tokens))}</td>
      <td class="n">${rate == null ? '<span class="report__unknown">none</span>' : `$${rate.toFixed(2)}`}</td>
      <td class="n">${escHtml(money(dollars))}</td>
      <td class="n">${escHtml(pct(dollars / c.cost.total))}</td>
      <td class="report__cell-note">${escHtml(note)}</td>
    </tr>`;
  }).join('');

  return `<section class="report__block report__block--break">
    <h2>Where the bill came from</h2>
    ${statGrid([
    { label: 'Actual, with cache', value: money0(c.cost.total) },
    { label: 'Same tokens, no cache', value: money0(c.uncached) },
    { label: 'Avoided', value: money0(c.saved) },
    { label: 'Cheaper by', value: mult(c.multiple) },
  ])}
    <div class="report__split">
      ${donut([
    { label: 'Cache read', value: tk.cache_read },
    { label: 'Fresh input', value: tk.input },
    { label: '5m write', value: tk.cache_write_5m },
    { label: '1h write', value: tk.cache_write_1h },
    { label: 'Output', value: tk.output },
  ], {
    size: 150, legend: true, center: pct(c.hitRatio, 0),
    title: 'Token mix', scale: 'read share of input',
    ariaLabel: 'Token volume by class',
  })}
      <p class="report__note">
        Cache reads are <strong>${escHtml(pct(tk.cache_read / (sumTokens(tk) || 1)))}</strong>
        of the token volume and <strong>${escHtml(pct(readShare))}</strong> of the cost.
        Writes are <strong>${escHtml(pct(writeShare))}</strong>. Without any cache these
        tokens would have cost <strong>${escHtml(money0(c.uncached))}</strong> instead of
        <strong>${escHtml(money0(c.cost.total))}</strong>. That is a counterfactual, not a
        discount anyone applied: without caching the same work would have been done
        differently, or not at all.
      </p>
    </div>
    <table class="report__table">
      <thead><tr>
        <th>Class</th><th class="n">Tokens</th><th class="n">Effective $/MTok</th>
        <th class="n">Cost</th><th class="n">Share</th><th>Why</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${tk.thinking ? `<p class="report__note">Of the output, ${escHtml(count(tk.thinking))} `
    + `tokens (${escHtml(pct(tk.output ? tk.thinking / tk.output : 0))}) were reasoning. `
    + 'They are already inside the output count and are never billed twice.</p>' : ''}
  </section>`;
}

/** The rates that actually produced the figures, so the report can be checked
 *  without the page that made it. */
function ratesPart(state, view) {
  if (!state.baseRates) return '';
  const { used } = modelsInPlay(view.rates, state.doc);
  if (!used.length) return '';

  const rows = used.map((name) => {
    const pair = publishedPair(view.rates, name);
    const base = publishedPair(state.baseRates, name);
    const editedIn = pair && base && pair.input !== base.input;
    const editedOut = pair && base && pair.output !== base.output;
    if (!pair) {
      return `<tr><td>${escHtml(name)}</td>`
        + '<td class="n" colspan="5"><span class="report__unknown">no published rate</span></td></tr>';
    }
    const m = view.rates.multipliers || {};
    const cell = (v, was) => (was
      ? `$${v.toFixed(2)} <span class="report__unknown">was $${was.toFixed(2)}</span>`
      : `$${v.toFixed(2)}`);
    return `<tr>
      <td>${escHtml(name)}</td>
      <td class="n">${cell(pair.input, editedIn ? base.input : null)}</td>
      <td class="n">${cell(pair.output, editedOut ? base.output : null)}</td>
      <td class="n">$${(pair.input * (m.cache_read ?? 0.1)).toFixed(2)}</td>
      <td class="n">$${(pair.input * (m.cache_write_5m ?? 1.25)).toFixed(2)}</td>
      <td class="n">$${(pair.input * (m.cache_write_1h ?? 2)).toFixed(2)}</td>
    </tr>`;
  }).join('');

  return `<section class="report__block report__block--break">
    <h2>The rates these figures were priced at</h2>
    <p class="report__note">Dollars per million tokens. The three cache columns are
    derived from base input by the documented multipliers, never typed per model,
    so a corrected base rate cannot leave a stale cache rate behind.</p>
    <table class="report__table">
      <thead><tr>
        <th>Model</th><th class="n">Input</th><th class="n">Output</th>
        <th class="n">Cache read</th><th class="n">5m write</th><th class="n">1h write</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function methodPart(state, view) {
  const p = state.parity;
  const parity = !p
    ? 'The pricing engine was still being checked when this report was made.'
    : p.ok
      ? `Engine parity: ${count(p.total)} of ${count(p.total)} fixture cases pass. The `
        + 'pricing engine in the browser and the one in releve_cost.py are asserted '
        + 'against the same file, so a figure here and a figure from the scripts are '
        + 'the same calculation.'
      : `Engine parity FAILED: ${count(p.failures.length)} of ${count(p.total)} cases. `
        + 'Treat every dollar figure in this report as unverified.';

  const limits = [
    ['Not an invoice', 'Every dollar here is tokens multiplied by a published list rate. '
      + 'Nothing read a bill, a subscription statement, or the Admin API, so no figure '
      + 'is authoritative billed spend.'],
    ['The plan figure is an input', `The subscription number is $${count(state.planCost)}/month `
      + 'as entered on the page, pro-rated across the window by calendar days. It is not '
      + 'read from an account.'],
    ['Cache multipliers are the one unverified constant', '1.25x for a five-minute write, '
      + '2x for one hour, 0.1x for a read. They are the documented multipliers of base '
      + 'input, and they are not checked against a bill.'],
    ['Unpriced is not free', 'A model with no published rate has its tokens and turns '
      + 'counted in their own bucket and left out of every total, never priced at a '
      + 'similar model\'s rate and never rendered as zero.'],
    ['Attribution is best-effort', 'Skill, effort, branch and project labels are whatever '
      + 'the transcript recorded. A turn with no label is grouped under (none), not dropped.'],
  ];

  return `<section class="report__block report__block--break">
    <h2>How to check this</h2>
    <p class="report__note report__note--parity${p && !p.ok ? ' report__note--bad' : ''}">${escHtml(parity)}</p>
    <p class="report__note">Every figure in this report can be reproduced from your own
    machine. The scanner is Python 3, standard library only, and makes no network call
    unless asked:</p>
    <pre class="report__cmd">curl -O https://releve.neorgon.com/scripts/releve-scan.py
curl -O https://releve.neorgon.com/scripts/releve_cost.py
python3 releve-scan.py --days ${escHtml(String(view.window.days || 30))} --out releve.json</pre>
    <h3>Limits, stated</h3>
    <dl class="report__deflist">${limits.map(([dt, dd]) => `
      <div><dt>${escHtml(dt)}</dt><dd>${escHtml(dd)}</dd></div>`).join('')}</dl>
  </section>`;
}

function colophon(state, view) {
  const w = view.window;
  return `<footer class="report__colophon">
    <span>Releve · releve.neorgon.com</span>
    <span>${escHtml(shortDate(w.from))} to ${escHtml(shortDate(w.to))}</span>
    <span>${escHtml(money(view.totals.cost.total))} API-equivalent, at list rates</span>
    <span>Prepared ${escHtml(stamp())}</span>
  </footer>`;
}

/* ── Small helpers ──────────────────────────────────────────── */

function sumTokens(tk) {
  if (!tk) return 0;
  return (tk.input || 0) + (tk.output || 0) + (tk.cache_read || 0)
    + (tk.cache_write_5m || 0) + (tk.cache_write_1h || 0);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(iso) {
  if (!iso) return 'an unknown date';
  const [y, m, d] = iso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1] || ''} ${y}`;
}

function bucketLabel(key, bucket) {
  if (bucket === 'month') {
    const [y, m] = key.split('-');
    return `${MONTHS[Number(m) - 1].slice(0, 3)} ${y.slice(2)}`;
  }
  return shortDate(key);
}

function shortKey(key) {
  const s = String(key).replace(/^claude-/, '');
  return s.length <= 14 ? s : `…${s.slice(-13)}`;
}

/** The rate card's own verified stamp, spelled out. The raw ISO string broke
 *  across a line as "2026-08-" / "27" in the standfirst. */
function dateOf(state) {
  const iso = state.baseRates && state.baseRates.verified;
  return iso ? longDate(iso) : 'a date it did not record';
}

function stamp() {
  const d = new Date();
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
}
