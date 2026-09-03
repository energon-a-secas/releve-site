// ── Render ───────────────────────────────────────────────────
// One direction only: state -> view -> HTML. Nothing here reads the DOM to
// decide what to draw, and nothing here mutates state. events.js changes state
// and calls render(); render() rebuilds every section from the same derived
// view, so two sections cannot disagree about a number.
//
// Sections are rebuilt wholesale rather than patched. The whole view is a few
// thousand objects and a dozen innerHTML writes, which is well under a frame at
// this size, and it removes the entire class of bug where one section is showing
// last filter's numbers.

import { buildView } from './filters.js';
import { state } from './state.js';
import { $, escHtml } from './utils.js';
import * as kpi from './widgets/kpi.js';
import * as timeline from './widgets/timeline.js';
import * as breakdown from './widgets/breakdown.js';
import * as cache from './widgets/cache.js';
import * as ratecard from './widgets/ratecard.js';
import * as projector from './widgets/projector.js';
import * as repo from './widgets/repo.js';
import * as method from './widgets/method.js';

let _animatedDoc = null;

/** Rebuild everything from state. Returns the derived view so callers that need
 *  it (the exporter, the brush) do not rebuild it a second time. */
export function render(s = state) {
  $('sourceBanner').innerHTML = kpi.sourceBanner(s.source);

  if (!s.doc || !s.baseRates) {
    // Sections 5 and 8 do not depend on a dataset, so the page is still useful
    // while the fetch is in flight or after it has failed.
    renderMethod(s, null);
    return null;
  }

  const view = buildView(s);
  s.derived = view;
  // Charts animate when the dataset changes, not on every filter click or rate
  // keystroke: the grow effect replaying under a typing hand reads as flicker.
  view.animate = s.doc !== _animatedDoc;
  _animatedDoc = s.doc;

  renderStatement(view);
  renderTimeline(view);
  renderBreakdown(view);
  renderCache(view);
  renderRepo(s, view);
  renderProjector(s, view);
  renderRates(s, view);
  renderMethod(s, view);

  return view;
}

// ── 1. Statement ─────────────────────────────────────────────

function renderStatement(view) {
  $('headline').innerHTML = kpi.headline(view);
  $('statementNote').innerHTML = kpi.statementNote(view);
  const stats = kpi.statementStats(view);
  $('statementStats').innerHTML = stats;
  $('statementStats').hidden = !stats;
  $('filters').innerHTML = kpi.filterChips(view);
}

// ── 2. Timeline ──────────────────────────────────────────────

function renderTimeline(view) {
  $('windowPresets').innerHTML = timeline.presets(view);
  $('timelineChart').innerHTML = timeline.chart(view);
  $('timelineLegend').innerHTML = timeline.legend(view);
  $('timelineTrend').innerHTML = timeline.trend(view);

  // The date inputs are both a control and a readout, so they are pushed from
  // the view rather than left at whatever the visitor last typed: a preset or a
  // brush has to be visible in them too.
  const from = $('fromDate');
  const to = $('toDate');
  if (document.activeElement !== from) from.value = view.window.from || '';
  if (document.activeElement !== to) to.value = view.window.to || '';
  // Chrome fires `change` per completed segment while a date is being typed,
  // and any attribute write to the focused input resets its segment-typing
  // buffer ("1" then "3" lands as 03, not 13). min/max only actually change
  // when the dataset does, so skip the write when the value is already right.
  const lo = view.window.allFrom || '';
  const hi = view.window.allTo || '';
  if (from.min !== lo) from.min = lo;
  if (from.max !== hi) from.max = hi;
  if (to.min !== lo) to.min = lo;
  if (to.max !== hi) to.max = hi;
  $('bucketSel').value = view.bucket;
}

// ── 3. Breakdowns ────────────────────────────────────────────

function renderBreakdown(view) {
  $('dimTabs').innerHTML = breakdown.tabs(view);
  $('breakdownBars').innerHTML = breakdown.chart(view);
  $('breakdownTable').innerHTML = breakdown.table(view);
  const note = breakdown.note(view);
  $('breakdownNote').innerHTML = note;
  $('breakdownNote').hidden = !note;
}

// ── 4. Cache lab ─────────────────────────────────────────────

function renderCache(view) {
  $('cacheHeadline').innerHTML = cache.headline(view);
  $('cacheMix').innerHTML = cache.mix(view);
  $('cacheRatio').innerHTML = cache.ratio(view);
  $('cacheNote').innerHTML = cache.note(view);
  $('cacheTable').innerHTML = cache.table(view);
}

// ── 5. Repo scanner ──────────────────────────────────────────

function renderRepo(s, view) {
  $('repoOut').innerHTML = repo.render(s.repo, s, view);
}

// ── 6. Projector ─────────────────────────────────────────────

function renderProjector(s, view) {
  const opts = projector.options(s);
  $('projModel').innerHTML = opts.models;
  $('projEffort').innerHTML = opts.efforts;

  setSlider('projIter', s.proj.iterations, String(s.proj.iterations));
  setSlider('projTurns', s.proj.turnsPerIteration, String(s.proj.turnsPerIteration));
  setSlider('projHit', s.proj.hitRatio * 100, `${(s.proj.hitRatio * 100).toFixed(1)}%`);
  setSlider('projTtl', s.proj.ttl1hShare * 100, `${Math.round(s.proj.ttl1hShare * 100)}%`);
  if (document.activeElement !== $('planCost')) $('planCost').value = s.planCost;

  const p = projector.project(s, view.rates);
  $('projOut').innerHTML = projector.output(s, view, p);
  $('projSensitivity').innerHTML = projector.sensitivity(s, view, p);
  $('projNote').innerHTML = projector.note(s, view, p);
}

/** Section 6 alone. A slider drag fires dozens of events and touches nothing
 *  outside the projector, so it does not need the whole page rebuilt. */
export function renderProjection(s = state) {
  if (!s.derived) return;
  renderProjector(s, s.derived);
}

/** Section 5 alone, for a folder count that finished. */
export function renderRepoSection(s = state) {
  if (!s.derived) return;
  renderRepo(s, s.derived);
}

/** Push a value into a range input and its readout. Skipped while the visitor is
 *  dragging it, because rewriting the value mid-drag fights the pointer. */
function setSlider(id, value, label) {
  const input = $(id);
  if (input && document.activeElement !== input) input.value = value;
  const out = $(`${id}Val`);
  if (out) out.textContent = label;
}

// ── 7. Rate card ─────────────────────────────────────────────

function renderRates(s, view) {
  $('ratesProvenance').innerHTML = ratecard.provenance(s, view);
  $('ratesProvenance').className = view.edited ? 'note note--warn' : 'note';
  // Rebuilding the table would destroy the input the visitor is typing in, along
  // with the caret. The rest of the page still repriced; the table's own numbers
  // are the ones being edited, so they are already correct on screen.
  const table = $('ratesTable');
  if (!table.contains(document.activeElement)) {
    table.innerHTML = ratecard.table(s, view);
  }
  $('multipliersTable').innerHTML = ratecard.multipliers(view);
  $('tiersTable').innerHTML = ratecard.tiers(view);
  $('ratesReset').disabled = !view.edited;
}

// ── 8. Method ────────────────────────────────────────────────

function renderMethod(s, view) {
  const p = method.parity(s);
  $('parityBox').className = p.cls;
  $('parityBox').innerHTML = p.html;
  $('scriptList').innerHTML = method.scriptList();
  if (!s.doc) return;
  $('methodQuality').innerHTML = method.quality(s, view);
  $('methodLimits').innerHTML = method.limits(s, view);
}

// ── Failure ──────────────────────────────────────────────────

/** A page that cannot price anything says so, in the place the numbers would
 *  have been. Rendering zeros would be a lie with a nice layout. */
export function renderFailure(message) {
  $('sourceBanner').innerHTML = '<span class="source__tag">failed</span>'
    + `<span class="source__note">${escHtml(message)}</span>`
    + '<span class="source__actions"><button class="btn btn--ghost btn--sm" '
    + 'data-open-load>Load a file instead</button></span>';
  $('headline').innerHTML = '';
  $('statementNote').innerHTML = '<p>No dataset loaded, so there is nothing to '
    + 'price. Run <code>releve-scan.py</code> and load its output, or reload the '
    + 'page to retry the demo dataset.</p>';
}
