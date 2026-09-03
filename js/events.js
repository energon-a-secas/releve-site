// ── Events ───────────────────────────────────────────────────
// Every listener on the page. Nothing is wired inline in the HTML.
//
// The shape is deliberate: a handler mutates state and calls render(). It never
// writes a number into the DOM itself. That is what makes "edit a rate and every
// section recomputes" true by construction rather than by remembering to update
// seven places.
//
// Two filters exist and only two: a date window, and at most one facet (one
// dimension, one key). A grid of independent multi-selects would let a visitor
// build a filter whose result they cannot describe, and the honest reading of a
// number depends on being able to say what it is a number of.

import { state, save } from './state.js';
import {
  render, renderProjection, renderRepoSection,
} from './render.js';
import { presetWindow } from './filters.js';
import { fromFile, loadDefault } from './ingest.js';
import { publishedPair } from './rates.js';
import * as timeline from './widgets/timeline.js';
import * as projector from './widgets/projector.js';
import * as repoWidget from './widgets/repo.js';
import {
  $, clamp, copyText, debounce, downloadJson, showToast,
} from './utils.js';

// ── Modal plumbing (from the template) ───────────────────────

/** @param {HTMLElement} root */
function getFocusable(root) {
  const sel = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  return Array.from(root.querySelectorAll(sel)).filter((el) => {
    if (el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true') return false;
    return el.getClientRects().length > 0;
  });
}

let _modalLastFocus = null;

/** @param {string} id */
export function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  _modalLastFocus = /** @type {HTMLElement} */ (document.activeElement);
  modal.removeAttribute('hidden');
  document.body.classList.add('modal-open');
  const dialog = modal.querySelector('.modal__dialog');
  const list = dialog ? getFocusable(dialog) : [];
  const closeBtn = modal.querySelector('.modal__header [data-modal-close]');
  const toFocus = closeBtn && list.includes(closeBtn) ? closeBtn : list[0];
  if (toFocus) toFocus.focus();
}

/** @param {string} id */
export function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.setAttribute('hidden', '');
  document.body.classList.remove('modal-open');
  if (_modalLastFocus && typeof _modalLastFocus.focus === 'function') {
    _modalLastFocus.focus();
  }
  _modalLastFocus = null;
}

function getOpenModal() {
  return document.querySelector('.modal:not([hidden])');
}

function onDocumentKeydown(e) {
  const modal = getOpenModal();
  if (!modal || !modal.id) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    closeModal(modal.id);
    return;
  }

  if (e.key !== 'Tab') return;
  const dialog = modal.querySelector('.modal__dialog');
  const list = dialog ? getFocusable(dialog) : [];
  if (list.length === 0) return;
  const first = list[0];
  const last = list[list.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function onModalClick(e) {
  const modal = /** @type {HTMLElement | null} */ (e.target.closest('.modal'));
  if (!modal || modal.hasAttribute('hidden')) return;
  if (e.target.closest('[data-modal-close]')) closeModal(modal.id);
}

// ── Adopting a dataset ───────────────────────────────────────

/**
 * Swap in a new dataset. Filters are cleared, because a window that made sense
 * for the old dataset almost certainly falls outside the new one, and the
 * projector is re-seeded from what the new dataset measured.
 */
export function adoptDoc(doc, source) {
  state.doc = doc;
  state.source = source;
  state.filters.from = null;
  state.filters.to = null;
  state.filters.facet = null;
  projector.seed(state);
  render(state);
}

async function loadFile(file) {
  if (!file) return;
  try {
    const rates = state.derived ? state.derived.rates : state.baseRates;
    const { doc, source } = await fromFile(file, rates);
    adoptDoc(doc, source);
    closeModal('loadModal');
    showToast(`Loaded ${file.name}`);
  } catch (err) {
    showToast(`Could not read ${file.name}: ${err.message}`);
  }
}

async function backToDemo() {
  try {
    const { doc, source } = await loadDefault();
    adoptDoc(doc, source);
    closeModal('loadModal');
  } catch (err) {
    showToast(`Could not reload the default dataset: ${err.message}`);
  }
}

// ── Filters ──────────────────────────────────────────────────

function setFacet(name, key) {
  const cur = state.filters.facet;
  state.filters.facet = (cur && cur.name === name && cur.key === key)
    ? null
    : { name, key };
  render(state);
}

function clearFilter(kind) {
  if (kind === 'window') {
    state.filters.from = null;
    state.filters.to = null;
  } else if (kind === 'facet') {
    state.filters.facet = null;
  } else if (kind === 'rates') {
    state.rateOverrides = {};
    save(state);
  }
  render(state);
}

function applyPreset(value) {
  const win = presetWindow(state.doc, value === 'all' ? null : Number(value));
  state.filters.from = win.from;
  state.filters.to = win.to;
  render(state);
}

/** Click a bar to narrow the window to that bucket; shift-click to extend the
 *  window out to it, which is the two-click version of a drag-brush. */
function brush(index, extend) {
  const view = state.derived;
  if (!view) return;
  const slot = view.series[index];
  if (!slot) return;
  if (extend && (state.filters.from || state.filters.to)) {
    const from = state.filters.from || view.window.from;
    if (slot.from < from) state.filters.from = slot.from;
    else state.filters.to = slot.to;
  } else {
    state.filters.from = slot.from;
    state.filters.to = slot.to;
  }
  render(state);
}

function onTimelineClick(e) {
  const svg = $('timelineChart').querySelector('svg');
  const view = state.derived;
  if (!svg || !view || !view.series.length) return;
  const i = timeline.bucketAtPointer(svg, e.clientX, view.series.length);
  if (i >= 0) brush(i, e.shiftKey);
}

function sortBy(id) {
  const v = state.view;
  if (v.sort === id) v.dir = v.dir === 'desc' ? 'asc' : 'desc';
  else { v.sort = id; v.dir = id === 'key' ? 'asc' : 'desc'; }
  render(state);
}

// ── Rate editing ─────────────────────────────────────────────

const repriceSoon = debounce(() => render(state), 140);

/**
 * One field of one model. An edit back to the published number deletes the
 * override rather than storing an identical value, so "edited rates" never
 * appears for a rate that matches the card.
 */
function applyRateEdit(el) {
  const model = el.dataset.rate;
  const field = el.dataset.field;
  const value = Number(el.value);
  if (!Number.isFinite(value) || value < 0) return;

  const published = publishedPair(state.baseRates, model);
  const over = { ...(state.rateOverrides[model] || {}) };
  if (published && published[field] === value) delete over[field];
  else over[field] = value;

  if (Object.keys(over).length) state.rateOverrides[model] = over;
  else delete state.rateOverrides[model];
  save(state);
  repriceSoon();
}

function resetRates() {
  state.rateOverrides = {};
  save(state);
  render(state);
  showToast('Published rates restored');
}

// ── Projector ────────────────────────────────────────────────

function onSlider(el) {
  const v = Number(el.value);
  if (!Number.isFinite(v)) return;
  if (el.id === 'projIter') state.proj.iterations = clamp(v, 1, 5000);
  else if (el.id === 'projTurns') state.proj.turnsPerIteration = clamp(v, 1, 5000);
  else if (el.id === 'projHit') state.proj.hitRatio = clamp(v / 100, 0, 1);
  else if (el.id === 'projTtl') state.proj.ttl1hShare = clamp(v / 100, 0, 1);
  renderProjection(state);
}

// ── Repo scanner ─────────────────────────────────────────────

async function loadRepoFile(file) {
  if (!file) return;
  try {
    const doc = repoWidget.validate(JSON.parse(await file.text()));
    state.repo = doc;
    renderRepoSection(state);
    showToast(`Loaded ${file.name}`);
  } catch (err) {
    showToast(`Not a releve-repo.json: ${err.message}`);
  }
}

async function countFolder(files) {
  if (!files || !files.length) return;
  $('repoOut').innerHTML = '<div class="viz-panel"><div class="viz-empty">'
    + `Reading ${files.length.toLocaleString()} files locally…</div></div>`;
  try {
    const table = await repoWidget.loadTokenizer();
    state.repo = await repoWidget.countFolder(files, table);
    renderRepoSection(state);
  } catch (err) {
    $('repoOut').innerHTML = '';
    showToast(`Could not count that folder: ${err.message}`);
  }
}

// ── Wiring helpers ───────────────────────────────────────────

/** A drop zone that also works by keyboard and by clicking, because a
 *  drag-and-drop-only affordance is unusable to anyone who cannot drag. */
function wireDrop(zoneId, inputId, handler) {
  const zone = $(zoneId);
  const input = $(inputId);
  if (!zone || !input) return;

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('is-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('is-over');
    handler(e.dataTransfer.files[0]);
  });
  zone.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;   // the zone's own buttons win
    input.click();
  });
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    handler(input.files[0]);
    input.value = '';                          // re-picking the same file re-fires
  });
}

function exportView() {
  const v = state.derived;
  if (!v) {
    showToast('Nothing loaded to export');
    return;
  }
  downloadJson('releve-view.json', {
    schema: 'releve-view/v1',
    exported: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    note: 'The filtered view as shown on releve.neorgon.com, not a fresh scan. '
      + 'Costs are tokens times a published list rate, and exact only where '
      + '"exact" is true.',
    source: state.source,
    window: v.window,
    facet: v.facet,
    plan: v.plan,
    rate_card: { version: state.baseRates.version, verified: state.baseRates.verified },
    rate_overrides: state.rateOverrides,
    exact: v.exact,
    caveats: v.notes,
    totals: v.totals,
    cache: {
      tokens: v.cache.tokens,
      cost: v.cache.cost,
      uncached_cost: v.cache.uncached,
      saved: v.cache.saved,
      hit_ratio: v.cache.hitRatio,
    },
    series: v.series.map((s) => ({
      key: s.key, from: s.from, to: s.to, turns: s.turns, cost: s.cost, by_model: s.byModel,
    })),
    breakdown: { dimension: v.dim, exact: v.rowsExact, rows: v.rows },
    unpriced: v.unpriced,
    excluded: v.excluded,
    quality: v.quality,
  });
}

/** Reset the reading, not the data: filters, cut, and rate edits. The dataset
 *  and the plan cost are the visitor's inputs and are left alone. */
function resetView() {
  state.filters.from = null;
  state.filters.to = null;
  state.filters.facet = null;
  state.view.dim = 'project';
  state.view.sort = 'cost';
  state.view.dir = 'desc';
  state.view.bucket = 'day';
  state.rateOverrides = {};
  save(state);
  render(state);
  showToast('Filters and rates reset');
}

/** Mark the rail link for whichever section is nearest the top of the viewport. */
function wireRail() {
  const links = Array.from(document.querySelectorAll('#rail .rail__link'));
  const sections = links
    .map((a) => document.querySelector(a.getAttribute('href')))
    .filter(Boolean);
  if (!sections.length || !('IntersectionObserver' in window)) return;

  const seen = new Map();
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) seen.set(entry.target.id, entry);
    let best = null;
    for (const entry of seen.values()) {
      if (!entry.isIntersecting) continue;
      if (!best || entry.boundingClientRect.top < best.boundingClientRect.top) best = entry;
    }
    for (const a of links) {
      const on = best && a.getAttribute('href') === `#${best.target.id}`;
      if (on) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    }
  }, { rootMargin: '-72px 0px -60% 0px', threshold: 0 });

  for (const s of sections) io.observe(s);
}

// ── Bind ─────────────────────────────────────────────────────

export function bindEvents() {
  document.addEventListener('keydown', onDocumentKeydown);
  document.addEventListener('click', onModalClick);

  // One delegated click handler: every control below is rendered fresh on each
  // pass, so binding them individually would mean rebinding them individually.
  document.addEventListener('click', (e) => {
    const t = e.target;

    // Every control below lives in markup the render pass replaces wholesale,
    // so the click destroyed the focused element and focus fell to <body>: a
    // keyboard user lost their place on every filter change. Re-find the same
    // control by the data attributes that identify it and put focus back.
    const refocus = (sel) => { document.querySelector(sel)?.focus(); };

    const clear = t.closest('[data-clear]');
    if (clear) { clearFilter(clear.dataset.clear); return; }

    const win = t.closest('[data-window]');
    if (win) {
      applyPreset(win.dataset.window);
      refocus(`[data-window="${CSS.escape(win.dataset.window)}"]`);
      return;
    }

    const facet = t.closest('[data-facet]');
    if (facet) {
      setFacet(facet.dataset.facet, facet.dataset.key);
      refocus(`[data-facet="${CSS.escape(facet.dataset.facet)}"][data-key="${CSS.escape(facet.dataset.key)}"]`);
      return;
    }

    const dim = t.closest('[data-dim]');
    if (dim) {
      state.view.dim = dim.dataset.dim;
      render(state);
      refocus(`[data-dim="${CSS.escape(dim.dataset.dim)}"]`);
      return;
    }

    const sort = t.closest('[data-sort]');
    if (sort) {
      sortBy(sort.dataset.sort);
      refocus(`[data-sort="${CSS.escape(sort.dataset.sort)}"]`);
      return;
    }

    // [data-pick], not tr[data-pick]: the key cell now carries a real button
    // with the same key, so the row action is reachable from the keyboard.
    const pick = t.closest('[data-pick]');
    if (pick && state.derived) {
      setFacet(state.derived.dim, pick.dataset.pick);
      refocus(`button[data-pick="${CSS.escape(pick.dataset.pick)}"]`);
      return;
    }

    if (t.closest('[data-open-load]')) { openModal('loadModal'); return; }

    const copy = t.closest('[data-copy]');
    if (copy) {
      const code = copy.closest('.cmd')?.querySelector('code');
      if (!code) return;
      copyText(code.textContent).then((ok) => {
        showToast(ok ? 'Copied' : 'Could not copy: select the text instead');
      });
    }
  });

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.matches('input[data-rate]')) { applyRateEdit(el); return; }
    if (el.matches('#projIter, #projTurns, #projHit, #projTtl')) { onSlider(el); return; }
    if (el.id === 'planCost') {
      const v = Number(el.value);
      if (Number.isFinite(v) && v >= 0) {
        state.planCost = v;
        save(state);
        repriceSoon();
      }
    }
  });

  $('loadDataBtn').addEventListener('click', () => openModal('loadModal'));
  $('exportBtn').addEventListener('click', exportView);
  $('resetBtn').addEventListener('click', resetView);
  $('ratesReset').addEventListener('click', resetRates);
  $('loadDemoAgain').addEventListener('click', backToDemo);

  $('bucketSel').addEventListener('change', (e) => {
    state.view.bucket = e.target.value;
    render(state);
  });
  $('fromDate').addEventListener('change', (e) => {
    state.filters.from = e.target.value || null;
    render(state);
  });
  $('toDate').addEventListener('change', (e) => {
    state.filters.to = e.target.value || null;
    render(state);
  });

  $('projModel').addEventListener('change', (e) => {
    state.proj.model = e.target.value;
    // Effort levels are per model, so the current one may not exist for the new
    // model. sampleFor() falls back to the model's largest sample and the select
    // is rebuilt to match it.
    const sample = projector.sampleFor(state);
    if (sample) state.proj.effort = sample.effort;
    renderProjection(state);
  });
  $('projEffort').addEventListener('change', (e) => {
    state.proj.effort = e.target.value;
    renderProjection(state);
  });
  $('projCalibrate').addEventListener('click', () => {
    projector.seed(state);
    renderProjection(state);
    showToast('Sliders reset to the dataset\'s medians');
  });

  $('dataPick').addEventListener('click', () => $('dataFile').click());
  $('repoPick').addEventListener('click', () => $('repoFile').click());
  $('repoFolder').addEventListener('click', () => $('repoDir').click());
  $('repoDir').addEventListener('change', (e) => {
    countFolder(e.target.files);
  });

  $('timelineChart').addEventListener('click', onTimelineClick);

  wireDrop('dataDrop', 'dataFile', loadFile);
  wireDrop('repoDrop', 'repoFile', loadRepoFile);
  wireRail();

  // Chart geometry is picked per render (timeline.geo(): 380 SVG units under
  // 700px, 760 above), so a resize that crosses the boundary needs a repaint
  // or the ticks render at half size on the side it landed on.
  let wasNarrow = matchMedia('(max-width: 700px)').matches;
  window.addEventListener('resize', debounce(() => {
    const narrow = matchMedia('(max-width: 700px)').matches;
    if (narrow !== wasNarrow) { wasNarrow = narrow; render(state); }
  }, 200));
}
