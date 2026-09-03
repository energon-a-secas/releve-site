// ── Section 2: Timeline ──────────────────────────────────────
// Cost per day (or week, or month), stacked by model. The chart is the brush:
// clicking a bar narrows the window to that bucket, shift-clicking extends the
// window to it, and every section below recomputes.
//
// Geometry is declared here rather than left to the Viz Kit's defaults because
// events.js has to map a click back to a bucket, and it can only do that if it
// knows the same numbers the chart was drawn with.

import { bars, statGrid, spark } from '../viz.js';
import { WINDOWS } from '../filters.js';
import { publishedPair } from '../rates.js';
import {
  big, count, escHtml, money, money0, shortDate,
} from '../utils.js';

/** Passed straight into bars(), which honors padL/padR, so the click mapping
 *  in bucketAtPointer() and the drawn chart share one set of numbers. The 38px
 *  gutter fits a five-digit tick ("999.9k"); 30px clipped "1,789".
 *  A function, not a constant: 760 SVG units squeezed into a 327px phone column
 *  rendered the 8px ticks at ~3.4 physical pixels. Half the units on a narrow
 *  viewport keeps text near 1:1; events.js re-renders on a resize crossing. */
export const geo = () => (
  typeof matchMedia !== 'undefined' && matchMedia('(max-width: 700px)').matches
    ? { width: 380, height: 170, padL: 38, padR: 6 }
    : { width: 760, height: 210, padL: 38, padR: 8 });

function bucketLabel(key, bucket) {
  if (bucket === 'month') {
    const [y, m] = key.split('-');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[Number(m) - 1]} ${y.slice(2)}`;
  }
  return shortDate(key);
}

export function presets(view) {
  return WINDOWS.map((w) => {
    const active = w.days === null
      ? view.window.full
      : view.window.days === w.days && !view.window.full;
    return `<button class="chip${active ? ' chip--on' : ''}" aria-pressed="${active}" data-window="${w.days ?? 'all'}">`
      + `${escHtml(w.label)}</button>`;
  }).join('');
}

export function chart(view) {
  const { series, models, bucket } = view;
  if (!series.length) {
    return '<div class="viz-panel"><div class="viz-empty">No turns in this window</div></div>';
  }

  const data = series.map((slot) => ({
    label: bucketLabel(slot.key, bucket),
    value: models.map((m) => slot.byModel[m] || 0),
  }));

  // The same series as a real table, visually hidden: the SVG is one flat
  // role=img, so this is the only way a screen reader or keyboard user can
  // read the numbers the bars draw.
  const srTable = `<table class="sr-only"><caption>Cost per ${escHtml(bucket)}</caption>
    <thead><tr><th>${escHtml(bucket)}</th><th>cost</th></tr></thead><tbody>
    ${series.map((slot) => `<tr><td>${escHtml(bucketLabel(slot.key, bucket))}</td><td>${escHtml(money(slot.cost))}</td></tr>`).join('')}
    </tbody></table>`;

  return bars(data, {
    ...geo(),
    keys: models,
    title: `Cost per ${bucket}`,
    scale: money0(view.totals.cost.total),
    ariaLabel: `Cost per ${bucket}, stacked by model`,
    animate: view.animate !== false,
  }) + srTable;
}

/** The legend doubles as a model filter: the colours only mean something if you
 *  can find out which model is which, and once you know you want to click it. */
export function legend(view) {
  if (!view.models.length) return '';
  const totals = new Map();
  for (const slot of view.series) {
    for (const [m, cost] of Object.entries(slot.byModel)) {
      totals.set(m, (totals.get(m) || 0) + cost);
    }
  }
  return view.models.map((m, i) => {
    const on = view.facet && view.facet.name === 'model' && view.facet.key === m;
    // A model with no published rate contributes no dollars, and $0.00 next to
    // its name reads as "this one was free". Name the reason instead.
    const priced = !!publishedPair(view.rates, m);
    const figure = priced
      ? `<span class="num num--muted">${money(totals.get(m) || 0)}</span>`
      : '<span class="num num--unknown">unpriced</span>';
    return `<button class="chip${on ? ' chip--on' : ''}" aria-pressed="${on}" data-facet="model" data-key="${escHtml(m)}">`
      + `<span style="width:9px;height:9px;border-radius:2px;background:var(--viz-c${(i % 8) + 1})"></span>`
      + `${escHtml(m.replace(/^claude-/, ''))} `
      + `${figure}</button>`;
  }).join('');
}

/** Four readings off the series. The peak day is the one worth naming: a bill is
 *  usually one or two days of unusual work, not a level rate. */
export function trend(view) {
  const per = view.perDay;
  if (!per.length) return '';

  const costs = per.map((d) => d.cost);
  const peak = per.reduce((a, b) => (b.cost > a.cost ? b : a), per[0]);
  // A bill is usually one or two days of unusual work; name what the work ran
  // on, not only what it cost.
  const driver = Object.entries(peak.byModel || {}).sort((a, b) => b[1] - a[1])[0];
  const driverNote = driver && driver[1] > peak.cost / 2
    ? `, mostly ${driver[0].replace(/^claude-/, '')}`
    : '';
  const active = per.filter((d) => d.turns > 0).length;
  const mean = active ? costs.reduce((a, b) => a + b, 0) / active : 0;
  const tokens = view.totals.tokens;
  const total = tokens.input + tokens.output + tokens.cache_read
    + tokens.cache_write_5m + tokens.cache_write_1h;

  const stats = statGrid([
    { label: 'Per active day', value: money0(mean) },
    { label: 'Peak day', value: money0(peak.cost) },
    { label: 'Turns per active day', value: active ? count(Math.round(view.totals.turns / active)) : '0' },
    { label: 'Tokens', value: big(total) },
  ]);

  return `${stats}
    <div class="viz-panel">
      <div class="viz-head">
        <span class="viz-title">Daily shape</span>
        <span class="viz-scale">${escHtml(shortDate(peak.date))} was the peak, ${escHtml(money0(peak.cost))}${escHtml(driverNote)}</span>
      </div>
      ${spark(costs, { width: 320, height: 34, ariaLabel: 'Daily cost trend' })}
    </div>`;
}

/**
 * Which bar a click landed on, from the pointer's position inside the SVG.
 * The Viz Kit returns strings, so the bars carry no data attributes; the
 * geometry is deterministic, which is enough.
 * @returns {number} index into view.series, or -1
 */
export function bucketAtPointer(svg, clientX, n) {
  if (!svg || !n) return -1;
  const box = svg.getBoundingClientRect();
  if (!box.width) return -1;
  const g = geo();
  const x = ((clientX - box.left) / box.width) * g.width;
  const plot = g.width - g.padL - g.padR;
  const i = Math.floor(((x - g.padL) / plot) * n);
  return i >= 0 && i < n ? i : -1;
}
