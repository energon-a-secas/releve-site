// ── Section 3: Breakdowns ────────────────────────────────────
// One total, eight cuts. The table is the primary surface (it is the thing you
// sort and reconcile) and the bar chart is the shape of its top rows.
//
// Two rules the table has to keep:
//   · An unpriced row shows the word "unpriced" in the cost column, never
//     $0.00. Zero is a claim, and it is the wrong one.
//   · A row whose token breakdown was not recorded for this window shows an
//     em-space, not a zero, and #breakdownNote says why.

import { bars } from '../viz.js';
import { DIMS } from '../state.js';
import { geo } from './timeline.js';
import {
  big, count, escHtml, money, pct,
} from '../utils.js';

const TOP_BARS = 12;

export function tabs(view) {
  return DIMS.map((d) => `<button class="chip${d.name === view.dim ? ' chip--on' : ''}" `
    + `aria-pressed="${d.name === view.dim}" data-dim="${d.name}">${escHtml(d.label)}</button>`).join('');
}

export function chart(view) {
  const priced = view.rows.filter((r) => r.cost.total > 0).slice(0, TOP_BARS);
  if (!priced.length) {
    return '<div class="viz-panel"><div class="viz-empty">Nothing priced in this cut</div></div>';
  }
  const dim = DIMS.find((d) => d.name === view.dim);
  return bars(priced.map((r) => ({
    label: shortKey(r.key),
    value: r.cost.total,
    color: r.picked ? 'var(--accent-bright)' : undefined,
  })), {
    width: geo().width,
    height: 200,
    padL: 38,
    title: `Cost by ${(dim && dim.label) || view.dim}`,
    scale: priced.length < view.rows.length
      ? `top ${priced.length} of ${view.rows.length}`
      : `${view.rows.length} in total`,
    ariaLabel: `Cost by ${(dim && dim.label) || view.dim}`,
    animate: view.animate !== false,
  });
}

/** Keys are project paths and branch names, which are long. The tooltip keeps
 *  the whole thing; the axis gets the tail, which is the distinguishing part. */
function shortKey(key) {
  const s = String(key).replace(/^claude-/, '');
  if (s.length <= 14) return s;
  return `…${s.slice(-13)}`;
}

const COLUMNS = [
  { id: 'key', label: 'Key', align: '' },
  { id: 'cost', label: 'Cost', align: 'n' },
  { id: 'turns', label: 'Turns', align: 'n' },
  { id: 'tokens', label: 'Tokens', align: 'n' },
  { id: null, label: 'Share', align: '' },
];

export function table(view) {
  if (!view.rows.length) {
    return '<caption class="num--muted">No rows in this window</caption>';
  }
  const maxShare = view.rows.reduce((m, r) => Math.max(m, r.share), 0) || 1;

  const head = COLUMNS.map((c) => {
    const cls = c.align ? ' class="n"' : '';
    if (!c.id) return `<th${cls}>${c.label}</th>`;
    const sorted = view.sortKey === c.id;
    // aria-sort belongs on the columnheader, not on the button inside it: on a
    // role=button it is invalid and assistive tech drops it, so the sort state
    // was visible (the CSS arrow) and announced to nobody.
    const sort = sorted ? ` aria-sort="${view.sortDir === 'asc' ? 'ascending' : 'descending'}"` : '';
    return `<th${cls}${sort}><button class="table__sort" data-sort="${c.id}"`
      + `>${c.label}</button></th>`;
  }).join('');

  const body = view.rows.map((r) => {
    const allUnpriced = r.turns > 0 && r.unpriced_turns === r.turns;
    const cost = allUnpriced
      ? '<span class="num num--unknown">unpriced</span>'
      : `<span class="num num--money">${escHtml(money(r.cost.total))}</span>`
        + (r.unpriced_turns
          ? ` <span class="num num--unknown" title="${count(r.unpriced_turns)} `
            + 'turns in this row have no published rate and are not in the figure">+?</span>'
          : '');
    const tokens = r.tokens
      ? `<span class="num">${escHtml(big(totalTokens(r)))}</span>`
      : '<span class="num num--muted" title="Not recorded per day for this cut">&#8195;</span>';
    return `<tr data-pick="${escHtml(r.key)}"${r.picked ? ' class="is-picked"' : ''}>
      <td class="table__key" title="${escHtml(r.key)}"><button class="table__pick" `
      + `data-pick="${escHtml(r.key)}" aria-pressed="${!!r.picked}">${escHtml(r.key)}</button></td>
      <td class="n">${cost}</td>
      <td class="n"><span class="num">${escHtml(count(r.turns))}</span></td>
      <td class="n">${tokens}</td>
      <td><span class="rowbar" title="${escHtml(pct(r.share))} of the window">`
      + `<i style="width:${(r.share / maxShare * 100).toFixed(1)}%"></i></span></td>
    </tr>`;
  }).join('');

  return `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
}

function totalTokens(r) {
  return r.tokens.input + r.tokens.output + r.tokens.cache_read
    + r.tokens.cache_write_5m + r.tokens.cache_write_1h;
}

/** The note is shown only when a figure in this table is not exact. Saying
 *  "approximate" on an exact number is as misleading as the reverse. */
export function note(view) {
  const lines = [];
  if (!view.rowsExact) {
    lines.push('Costs in this cut are the window\'s own per-day figures scaled by '
      + 'the edited rate card, blended over each row\'s model mix across the whole '
      + 'dataset. A row that used one model is exact; a row that mixed models is '
      + 'within a fraction of a percent.');
  }
  if (!view.window.full && view.dim !== 'model' && !view.rows.some((r) => r.tokens)) {
    lines.push('Token counts are recorded per day for models only, so this cut shows '
      + 'turns and cost for the window and leaves the token column blank. Switch to '
      + 'the whole dataset to see it.');
  }
  for (const n of view.notes) lines.push(n);
  return lines.length ? lines.map((l) => `<p>${l}</p>`).join('') : '';
}
