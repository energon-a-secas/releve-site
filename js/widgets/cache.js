// ── Section 4: Cache lab ─────────────────────────────────────
// The section that explains the bill. Cache reads are the overwhelming majority
// of the token volume and a large minority of the cost, which is only legible
// next to the counterfactual: the same tokens priced as fresh input.
//
// The rate column is the *effective* blended rate (cost divided by tokens),
// not a card rate. A window spanning several models has no single card rate,
// and printing one model's would be a fiction.

import { donut, line, statGrid } from '../viz.js';
import { big, count, escHtml, money, money0, mult, pct } from '../utils.js';

const CLASSES = [
  {
    id: 'input', label: 'Fresh input', tokens: 'input', cost: 'input',
    note: 'Read by the model and not cached. Base rate.',
  },
  {
    id: 'write5m', label: 'Cache write, 5 min', tokens: 'cache_write_5m', cost: null,
    note: '1.25x base input. The default TTL.',
  },
  {
    id: 'write1h', label: 'Cache write, 1 hour', tokens: 'cache_write_1h', cost: null,
    note: '2x base input. Worth it only if the entry is read more than once an hour.',
  },
  {
    id: 'read', label: 'Cache read', tokens: 'cache_read', cost: 'cache_read',
    note: '0.1x base input. Where the saving is.',
  },
  {
    id: 'output', label: 'Output', tokens: 'output', cost: 'output',
    note: 'Includes thinking tokens, which are already inside this count.',
  },
];

export function headline(view) {
  const c = view.cache;
  return statGrid([
    { label: 'Actual, with cache', value: money0(c.cost.total) },
    { label: 'Same tokens, no cache', value: money0(c.uncached) },
    { label: 'Avoided', value: money0(c.saved) },
    { label: 'Cheaper by', value: mult(c.multiple) },
  ]);
}

export function mix(view) {
  const tk = view.cache.tokens;
  return donut([
    { label: 'Cache read', value: tk.cache_read },
    { label: 'Fresh input', value: tk.input },
    { label: '5m write', value: tk.cache_write_5m },
    { label: '1h write', value: tk.cache_write_1h },
    { label: 'Output', value: tk.output },
  ], {
    size: 168,
    legend: true,
    center: pct(view.cache.hitRatio, 0),
    title: 'Token mix',
    scale: 'read share of input',
    ariaLabel: 'Token volume by class',
  });
}

/** Two lines, and the gap between them is the whole argument. */
export function ratio(view) {
  const series = view.cache.ratioSeries;
  if (!series.length) return '';
  return line([
    { name: 'No cache', values: series.map((d) => d.uncached), color: 'var(--viz-c3)' },
    { name: 'Actual', values: series.map((d) => d.cost), color: 'var(--viz-accent-bright)' },
  ], {
    width: 380,
    height: 200,
    area: true,
    animate: true,
    title: 'Cost per day, actual against no-cache',
    scale: money0(view.cache.uncached),
    ariaLabel: 'Daily cost with and without cache',
  });
}

export function note(view) {
  const c = view.cache;
  if (!c.cost.total) return 'No priced turns in this window.';
  const readShare = c.cost.total ? c.cost.cache_read / c.cost.total : 0;
  const writeShare = c.cost.total ? c.cost.cache_write / c.cost.total : 0;
  return `Cache reads are <strong>${pct(volumeShare(c.tokens))}</strong> of the token `
    + `volume and <strong>${pct(readShare)}</strong> of the cost. Writes are `
    + `<strong>${pct(writeShare)}</strong>. Without any cache these tokens would `
    + `have cost <strong>${escHtml(money0(c.uncached))}</strong> instead of `
    + `<strong>${escHtml(money0(c.cost.total))}</strong>, so the cache avoided `
    + `<strong>${escHtml(money0(c.saved))}</strong>. That is the counterfactual, `
    + 'not a discount anyone applied: without caching the same work would have '
    + 'been done differently, or not at all.';
}

function volumeShare(tk) {
  const total = tk.input + tk.output + tk.cache_read
    + tk.cache_write_5m + tk.cache_write_1h;
  return total ? tk.cache_read / total : 0;
}

export function table(view) {
  const tk = view.cache.tokens;
  const cost = view.cache.cost;
  // The two write TTLs share one cost line in the contract, so split it by the
  // multipliers rather than reporting a combined row: the point of the section
  // is that the two TTLs are priced differently.
  const mults = (view.rates && view.rates.multipliers) || { cache_write_5m: 1.25, cache_write_1h: 2 };
  const w5 = tk.cache_write_5m * mults.cache_write_5m;
  const w1 = tk.cache_write_1h * mults.cache_write_1h;
  const wUnits = w5 + w1;
  const costOf = {
    input: cost.input,
    write5m: wUnits ? cost.cache_write * (w5 / wUnits) : 0,
    write1h: wUnits ? cost.cache_write * (w1 / wUnits) : 0,
    read: cost.cache_read,
    output: cost.output,
  };

  const totalCost = view.cache.cost.total || 1;
  const rows = CLASSES.map((c) => {
    const tokens = tk[c.tokens] || 0;
    const dollars = costOf[c.id] || 0;
    const rate = tokens ? (dollars / tokens) * 1e6 : null;
    return `<tr>
      <td>${escHtml(c.label)}</td>
      <td class="n"><span class="num">${escHtml(big(tokens))}</span></td>
      <td class="n"><span class="num num--muted">${rate == null ? '&#8195;' : `$${rate.toFixed(2)}`}</span></td>
      <td class="n"><span class="num num--money">${escHtml(money(dollars))}</span></td>
      <td class="n"><span class="num num--muted">${escHtml(pct(dollars / totalCost))}</span></td>
      <td class="num--muted">${escHtml(c.note)}</td>
    </tr>`;
  }).join('');

  const thinking = tk.thinking
    ? `<tfoot><tr><td colspan="6" class="num--muted">Of the output, `
      + `${count(tk.thinking)} tokens (${pct(tk.output ? tk.thinking / tk.output : 0)}) `
      + 'were reasoning. They are already inside the output count and are never '
      + 'billed twice.</td></tr></tfoot>'
    : '';

  return `<thead><tr>
      <th>Class</th><th class="n">Tokens</th><th class="n">Effective $/MTok</th>
      <th class="n">Cost</th><th class="n">Share</th><th>Why</th>
    </tr></thead><tbody>${rows}</tbody>${thinking}`;
}
