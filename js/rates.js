// ── Rate card ────────────────────────────────────────────────
// Load data/rates.json, and apply the visitor's edits on top of it without
// mutating the published card. Two cards therefore exist at all times: the one
// as published (baseRates) and the one in force (effective). Section 7 shows
// both, so an edited number never masquerades as a verified one.
//
// An edit sets a model's base input and output. Cache and batch rates are
// derived from base input by the multipliers, so editing input moves the cache
// rates with it, which is the behaviour the pricing page actually has.

const RATES_URL = 'data/rates.json';

/** Fetch the published card. Throws, because a page with no rates has nothing
 *  honest to display and must say so rather than render zeros. */
export async function loadRates(url = RATES_URL) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`rate card: HTTP ${res.status}`);
  const card = await res.json();
  if (!card || !card.models) throw new Error('rate card: no models');
  return card;
}

/**
 * The card in force: base plus overrides. Returns base unchanged when there is
 * nothing to override, so the common case allocates nothing.
 * @param {object} base
 * @param {Record<string, {input?: number, output?: number}>} overrides
 */
export function effectiveRates(base, overrides) {
  const names = Object.keys(overrides || {});
  if (!names.length) return base;

  const card = { ...base, models: { ...base.models } };
  for (const name of names) {
    const model = base.models[name];
    if (!model || !Array.isArray(model.periods) || !model.periods.length) continue;
    const over = overrides[name];
    // Every period moves together. A visitor editing "what if Opus cost $8"
    // means the whole window, not one historical price band.
    const periods = model.periods.map((p) => ({
      ...p,
      input: over.input != null ? over.input : p.input,
      output: over.output != null ? over.output : p.output,
    }));
    const next = { ...model, periods, edited: true };
    // Fast mode is a separate pair of rates. Keep its ratio to standard rather
    // than leaving it at the published absolute value, which would make an
    // edited standard rate exceed its own fast rate.
    if (model.speed && model.speed.fast) {
      const pub = model.periods[0] || {};
      const ratioIn = pub.input ? model.speed.fast.input / pub.input : 2;
      const ratioOut = pub.output ? model.speed.fast.output / pub.output : 2;
      next.speed = {
        ...model.speed,
        fast: {
          ...model.speed.fast,
          input: periods[0].input * ratioIn,
          output: periods[0].output * ratioOut,
        },
      };
    }
    card.models[name] = next;
  }
  return card;
}

/** Published base rates for one model, for the editor's placeholder values. */
export function publishedPair(base, name) {
  const model = base.models[name];
  const period = model && Array.isArray(model.periods) ? model.periods[model.periods.length - 1] : null;
  return period ? { input: period.input, output: period.output } : null;
}

/** Models worth showing in the editor: the ones this dataset actually used,
 *  in spend order, then anything else the card declares. A rate card listing
 *  fourteen models when the window used five buries the five. */
export function modelsInPlay(card, doc) {
  const used = new Map();
  for (const meta of Object.values((doc && doc.rate_keys) || {})) {
    used.set(meta.model, true);
  }
  for (const row of (doc && doc.dimensions && doc.dimensions.model) || []) {
    used.set(row.key, true);
  }
  const inCard = Object.keys(card.models);
  const first = inCard.filter((m) => used.has(m));
  const rest = inCard.filter((m) => !used.has(m));
  return { used: first, unused: rest };
}
