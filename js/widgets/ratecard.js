// ── Section 7: Rate card ─────────────────────────────────────
// Every rate the page used, where it came from, and an input box on each one.
// Editing a base rate reprices the whole page from tokens, which is the "allow
// adjustments" part of the brief and also the honest way to show how much of a
// total is a pricing assumption rather than a measurement.
//
// Cache rates are shown as derived values, never as editable fields: they are
// base input times a multiplier, and letting them drift apart would reintroduce
// exactly the bug this project exists to fix.

import { publishedPair, modelsInPlay } from '../rates.js';
import { count, escHtml, money, NO_VALUE, pct, shortModel } from '../utils.js';

export function provenance(state, view) {
  const base = state.baseRates;
  const parts = [
    `Rates transcribed from <a href="${escHtml(base.source || 'https://claude.com/pricing')}" `
    + 'target="_blank" rel="noopener noreferrer">the public pricing page</a> and '
    + `last checked <strong>${escHtml(base.verified || 'unknown')}</strong>`
    + `${base.version ? ` (card ${escHtml(base.version)})` : ''}.`,
  ];
  const dated = Object.entries(base.models || {})
    .filter(([, m]) => (m.periods || []).length > 1);
  if (dated.length) {
    parts.push(`${dated.length} model${dated.length === 1 ? ' has' : 's have'} a dated `
      + 'price change, applied per turn on the day it took effect: '
      + `${dated.map(([k]) => `<code>${escHtml(shortModel(k))}</code>`).join(', ')}.`);
  }
  if (view.edited) {
    const n = Object.keys(state.rateOverrides).length;
    parts.push(`<strong>${n} rate${n === 1 ? '' : 's'} edited.</strong> Every figure on `
      + 'this page is now hypothetical. Your edits are kept in this browser only.');
  }
  return parts.join(' ');
}

/** Turn counts per model in the current window, so an edit can be aimed at the
 *  rate that actually matters instead of the one at the top of the list. */
function usage(view) {
  const map = new Map();
  for (const row of view.dim === 'model' ? view.rows : []) map.set(row.key, row);
  if (map.size) return map;
  for (const slot of view.series) {
    for (const [model, cost] of Object.entries(slot.byModel)) {
      const prev = map.get(model) || { key: model, cost: { total: 0 }, turns: 0 };
      prev.cost = { total: prev.cost.total + cost };
      map.set(model, prev);
    }
  }
  return map;
}

export function table(state, view) {
  const base = state.baseRates;
  const eff = view.rates;
  const { used, unused } = modelsInPlay(base, state.doc);
  const seen = usage(view);
  const mults = eff.multipliers || {};

  const row = (name, inPlay) => {
    const model = eff.models[name] || {};
    const pub = publishedPair(base, name);
    const over = state.rateOverrides[name] || {};
    const edited = over.input != null || over.output != null;

    if (model.excluded) {
      return `<tr>
        <td class="table__key"><code>${escHtml(shortModel(name))}</code></td>
        <td colspan="5" class="num--muted">${escHtml(model.note || 'Never billed.')}</td>
        <td class="n"><span class="num num--muted">${escHtml(turnsOf(seen, name))}</span></td>
      </tr>`;
    }
    if (!pub) {
      return `<tr>
        <td class="table__key"><code>${escHtml(shortModel(name))}</code></td>
        <td colspan="5"><span class="num num--unknown">no published rate</span>
          <span class="num--muted">${escHtml(model.note || '')}</span></td>
        <td class="n"><span class="num num--unknown">${escHtml(turnsOf(seen, name))}</span></td>
      </tr>`;
    }

    const now = { input: model.periods[model.periods.length - 1].input,
      output: model.periods[model.periods.length - 1].output };
    const cell = (field) => `<input class="input input--num" type="number" min="0" step="0.5"
        value="${now[field]}" data-rate="${escHtml(name)}" data-field="${field}"
        aria-label="${escHtml(shortModel(name))} ${field} rate, dollars per million tokens"
        title="published ${pub[field]}">`;

    return `<tr${inPlay ? '' : ' class="num--muted"'}>
      <td class="table__key"><code>${escHtml(shortModel(name))}</code>${
        edited ? ' <span class="num num--warn" title="edited">edited</span>' : ''}</td>
      <td class="n">${cell('input')}</td>
      <td class="n">${cell('output')}</td>
      <td class="n"><span class="num num--muted">$${(now.input * (mults.cache_read ?? 0.1)).toFixed(2)}</span></td>
      <td class="n"><span class="num num--muted">$${(now.input * (mults.cache_write_5m ?? 1.25)).toFixed(2)}</span></td>
      <td class="n"><span class="num num--muted">$${(now.input * (mults.cache_write_1h ?? 2)).toFixed(2)}</span></td>
      <td class="n"><span class="num">${escHtml(turnsOf(seen, name))}</span></td>
    </tr>`;
  };

  const head = `<thead><tr>
      <th>Model</th>
      <th class="n">Input</th><th class="n">Output</th>
      <th class="n">Cache read</th><th class="n">5m write</th><th class="n">1h write</th>
      <th class="n">In window</th>
    </tr>
    <tr><th></th><th colspan="5" class="num--muted" style="text-transform:none;letter-spacing:0">
      dollars per million tokens; the three cache columns are derived from input
    </th><th></th></tr></thead>`;

  const bodyUsed = used.map((m) => row(m, true)).join('');
  const bodyRest = unused.length
    ? `<tr><td colspan="7" class="num--muted">Declared in the card but unused in this
        dataset. Shown because a rate you cannot see is a rate you cannot check.</td></tr>`
      + unused.map((m) => row(m, false)).join('')
    : '';

  return `${head}<tbody>${bodyUsed}${bodyRest}</tbody>`;
}

function turnsOf(seen, name) {
  const row = seen.get(name);
  if (!row) return NO_VALUE;
  return row.turns ? count(row.turns) : money(row.cost.total);
}

export function multipliers(view) {
  const m = view.rates.multipliers || {};
  const rows = [
    ['Cache write, 5 min', m.cache_write_5m, 'of base input'],
    ['Cache write, 1 hour', m.cache_write_1h, 'of base input'],
    ['Cache read', m.cache_read, 'of base input'],
    ['Batch tier', m.batch, 'of every rate'],
  ];
  const note = view.rates.multipliers && view.rates.multipliers.note;
  return `<dl class="deflist">${rows.map(([label, value, of]) => `
    <div><dt>${escHtml(label)}</dt>
    <dd><span class="num">${value == null ? '<span class="num--unknown">unknown</span>' : `${value}×`}</span>
      <span class="num--muted">${escHtml(of)}</span></dd></div>`).join('')}
    </dl>${note ? `<p class="prose num--muted">${escHtml(note)}</p>` : ''}`;
}

export function tiers(view) {
  const t = view.rates.service_tiers || {};
  const assumed = (view.quality || {}).tier_assumed_turns || 0;
  const rows = Object.entries(t).map(([name, entry]) => `
    <div><dt><code>${escHtml(name)}</code></dt>
    <dd>${entry.multiplier == null
    ? '<span class="num num--unknown">no flat multiple published</span>'
    : `<span class="num">${entry.multiplier}×</span>`}
      <span class="num--muted">${escHtml(entry.note || '')}</span></dd></div>`).join('');
  const foot = assumed
    ? `<p class="prose num--muted">${count(assumed)} turns ran on a tier with no `
      + 'published multiple. They are priced at standard and counted here rather '
      + 'than discounted by a guess.</p>'
    : '';
  return `<dl class="deflist">${rows}</dl>${foot}`;
}

/** A one-line reading of how much of the total rests on the unverified
 *  constants, which is the number a sceptic should be given first. */
export function sensitivity(view) {
  const c = view.cache.cost;
  const share = c.total ? (c.cache_read + c.cache_write) / c.total : 0;
  return `${pct(share)} of this total is priced by the cache multipliers rather `
    + 'than by a rate printed on the pricing page.';
}
