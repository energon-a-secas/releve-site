// ── Section 1: Statement ─────────────────────────────────────
// The headline figures, the provenance banner above them, and the filter chips
// that say what they are figures *of*. Every function here returns an HTML
// string; render.js owns the DOM.
//
// The rule this section exists to enforce: a figure and its provenance travel
// together. The dollar total is a counterfactual at list rates, and it says so
// on the same screen, not in a footnote.

import { DIMS } from '../state.js';
import {
  big, count, escHtml, money, money0, mult, pct, shortDate,
} from '../utils.js';

const SOURCE_TAGS = {
  demo: 'synthetic',
  local: 'your data',
  file: 'loaded file',
  jsonl: 'one transcript',
};

export function sourceBanner(source) {
  if (!source) {
    return '<span class="source__tag">loading</span>'
      + '<span class="source__note">Reading the dataset.</span>';
  }
  const tag = SOURCE_TAGS[source.kind] || source.kind;
  return `<span class="source__tag">${escHtml(tag)}</span>`
    + `<span class="source__note">${escHtml(source.note || '')}</span>`
    + '<span class="source__actions">'
    + '<button class="btn btn--ghost btn--sm" data-open-load>Load your own</button>'
    + '</span>';
}

/** Four cells. The two dollar figures answer different questions, so they sit
 *  side by side rather than one being "the" number. */
export function headline(view) {
  const t = view.totals;
  const p = view.plan;
  const tokens = t.tokens.input + t.tokens.output + t.tokens.cache_read
    + t.tokens.cache_write_5m + t.tokens.cache_write_1h;

  const cells = [
    {
      lead: true,
      label: 'API-equivalent, at list rates',
      value: money0(t.cost.total),
      foot: `${count(t.turns)} turns${t.unpriced_turns
        ? ` · ${count(t.unpriced_turns)} unpriced and not in this figure` : ''}`,
    },
    {
      label: `Plan cost, ${p.windowDays} days of $${count(p.monthly)}/mo`,
      value: money0(p.prorated),
      foot: 'What the subscription actually charged for this window',
    },
    {
      label: 'Ratio',
      value: mult(p.multiple),
      foot: p.multiple != null
        ? `${money(p.perDay)} of API-equivalent work per day`
        : 'Set a plan cost to compare',
    },
    {
      label: 'Billable tokens',
      value: big(tokens),
      foot: `${pct(view.cache.hitRatio)} of input served from cache`,
    },
  ];

  return cells.map((c) => `
    <div class="headline__cell${c.lead ? ' headline__cell--lead' : ''}">
      <span class="headline__label">${escHtml(c.label)}</span>
      <span class="headline__value num num--money">${escHtml(c.value)}</span>
      <span class="headline__foot">${escHtml(c.foot)}</span>
    </div>`).join('');
}

/** One paragraph, and it has to be the honest one. */
export function statementNote(view) {
  const w = view.window;
  const range = w.from === w.to
    ? shortDate(w.from)
    : `${shortDate(w.from)} to ${shortDate(w.to)}`;
  const parts = [
    `<strong>${range}</strong>, ${w.observed} day${w.observed === 1 ? '' : 's'} with `
    + 'recorded turns. The dollar figure is what these tokens would have cost '
    + 'through the API at published list rates: a counterfactual, not an invoice.',
  ];
  if (view.edited) {
    parts.push('<strong>Rates have been edited</strong>, so every figure below is '
      + 'hypothetical twice over. Reset them in section 7.');
  }
  if (view.facet) {
    const dim = DIMS.find((d) => d.name === view.facet.name);
    parts.push(`Filtered to ${escHtml((dim && dim.label) || view.facet.name)} `
      + `<strong>${escHtml(view.facet.key)}</strong>.`);
  }
  return parts.join(' ');
}

/** The counted-but-not-priced facts, which belong next to the total rather than
 *  buried in the Method section. Unknown is not zero. */
export function statementStats(view) {
  const rows = [];
  const u = view.unpriced;
  if (u && u.turns) {
    const names = (u.models || []).map((m) => m.model).join(', ');
    rows.push({
      cls: 'num--unknown',
      label: 'Unpriced',
      value: `${count(u.turns)} turns`,
      note: `${escHtml(names)}: no published rate, so ${big(sumTokens(u.tokens))} `
        + 'tokens are counted and left out of every dollar figure.',
    });
  }
  const e = view.excluded;
  if (e && e.turns) {
    rows.push({
      cls: 'num--muted',
      label: 'Excluded',
      value: `${count(e.turns)} turns`,
      note: 'Generated locally without an API call, so never billed by anyone.',
    });
  }
  const q = view.quality;
  if (q && q.estimated_cache_split_turns) {
    rows.push({
      cls: 'num--muted',
      label: 'Approximate',
      value: `${count(q.estimated_cache_split_turns)} turns`,
      note: 'Recorded only a flat cache-write counter, so the five-minute TTL was '
        + 'assumed. A one-hour write would have cost 60% more on those turns.',
    });
  }
  if (!rows.length) return '';

  return `<dl class="deflist">${rows.map((r) => `
    <div>
      <dt><span class="num ${r.cls}">${escHtml(r.label)}</span> <span class="num">${escHtml(r.value)}</span></dt>
      <dd>${r.note}</dd>
    </div>`).join('')}</dl>`;
}

function sumTokens(tk) {
  if (!tk) return 0;
  return (tk.input || 0) + (tk.output || 0) + (tk.cache_read || 0)
    + (tk.cache_write_5m || 0) + (tk.cache_write_1h || 0);
}

/** The sticky chip row. Shows the window, the facet, and any rate edit, each
 *  removable. An active filter the visitor cannot see is a bug report waiting
 *  to happen. */
export function filterChips(view) {
  const chips = [];
  const w = view.window;

  if (!w.full) {
    chips.push(chip(`${shortDate(w.from)} – ${shortDate(w.to)}`, 'window', 'Clear the date window'));
  }
  if (view.facet) {
    const dim = DIMS.find((d) => d.name === view.facet.name);
    chips.push(chip(
      `${(dim && dim.label) || view.facet.name}: ${view.facet.key}`,
      'facet', 'Clear this filter',
    ));
  }
  if (view.edited) {
    chips.push(chip('edited rates', 'rates', 'Restore the published rates'));
  }

  const label = '<span class="filters__label">Showing</span>';
  const body = chips.length
    ? chips.join('')
    : '<span class="chip chip--empty">everything in the dataset</span>';
  const exactness = view.exact
    ? ''
    : '<span class="chip chip--empty" title="Some figures are repriced from '
      + 'pre-aggregated tokens. See the note under the breakdown.">blended reprice</span>';
  return `${label}${body}${exactness}<span class="filters__spacer"></span>`
    + `<span class="num num--muted">${count(view.totals.turns)} turns · `
    + `${money(view.totals.cost.total)}</span>`;
}

function chip(text, kind, title) {
  return `<span class="chip chip--on">${escHtml(text)}`
    + `<button class="chip__x" data-clear="${kind}" title="${escHtml(title)}" `
    + `aria-label="${escHtml(title)}">&times;</button></span>`;
}
