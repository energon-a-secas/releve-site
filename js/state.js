// ── State ────────────────────────────────────────────────────
// One mutable object every module imports. Two things are persisted and
// nothing else: the plan cost and any rate edits, because those are the
// visitor's own inputs and losing them on reload is the annoying kind of bug.
// The dataset is never persisted: it can be 700 KB and it is reloaded from its
// source anyway.

const STORAGE_KEY = 'releve-state';

export const DIMS = [
  { name: 'model', label: 'Model' },
  { name: 'project', label: 'Project' },
  { name: 'skill', label: 'Skill' },
  { name: 'effort', label: 'Effort' },
  { name: 'lane', label: 'Lane' },
  { name: 'branch', label: 'Branch' },
  { name: 'tier', label: 'Tier' },
  { name: 'version', label: 'Version' },
];

export const state = {
  /** The loaded releve.json. */
  doc: null,
  /** Where it came from: { kind, label, note }. kind: demo | local | file | jsonl. */
  source: null,
  /** The rate card as published, before any edit. */
  baseRates: null,
  /** Rate edits, model -> { input, output }. Persisted. */
  rateOverrides: {},
  /** What the subscription costs per month. Persisted. Not derived from tokens. */
  planCost: 100,

  /** Date window plus at most one facet. See filters.js for why one. */
  filters: {
    from: null,
    to: null,
    /** { name, key } or null. */
    facet: null,
  },

  /** UI-only choices. bucket is the timeline's grouping. */
  view: {
    dim: 'project',
    sort: 'cost',
    dir: 'desc',
    bucket: 'day',
    top: 14,
  },

  /** Projector inputs. Seeded from the dataset's calibration on load. */
  proj: {
    model: null,
    effort: null,
    iterations: 20,
    turnsPerIteration: 40,
    hitRatio: 0.975,
    ttl1hShare: 0.67,
  },

  /** Result of cost.js selfCheck(). A failure is a blocker, not a warning. */
  parity: null,
  /** A dropped releve-repo.json, or an in-browser folder count. */
  repo: null,
  /** The derived, filtered, repriced view. Rebuilt by filters.js on every change. */
  derived: null,
};

/** Load the persisted slice. Never trusts the shape: a hand-edited or
 *  stale localStorage entry must not be able to break the page. */
export function loadSaved(s) {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    return;
  }
  if (!saved || typeof saved !== 'object') return;

  if (Number.isFinite(saved.planCost) && saved.planCost >= 0) {
    s.planCost = saved.planCost;
  }
  if (saved.rateOverrides && typeof saved.rateOverrides === 'object') {
    for (const [model, over] of Object.entries(saved.rateOverrides)) {
      if (!over || typeof over !== 'object') continue;
      const clean = {};
      for (const field of ['input', 'output']) {
        const v = Number(over[field]);
        if (Number.isFinite(v) && v >= 0) clean[field] = v;
      }
      if (Object.keys(clean).length) s.rateOverrides[model] = clean;
    }
  }
}

/** Persist only the visitor's own inputs. */
export function save(s) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      planCost: s.planCost,
      rateOverrides: s.rateOverrides,
    }));
  } catch { /* quota exceeded or private browsing */ }
}

/** True when any rate has been edited away from the published card. */
export function hasRateEdits(s) {
  return Object.keys(s.rateOverrides).length > 0;
}
