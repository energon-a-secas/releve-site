// ── Shared utilities ─────────────────────────────────────────
// Small, pure helper functions used across multiple modules.

/** Cached element lookup by ID. */
const _els = {};
export function $(id) {
  return _els[id] || (_els[id] = document.getElementById(id));
}

/** Escape HTML special characters. */
export function escHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Show a temporary toast notification. */
let _toastTimer = null;
export function showToast(msg) {
  let el = document.getElementById('app-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-toast';
    el.className = 'toast';
    // A live region, so the errors this surface carries are announced rather
    // than flashed. role=status is aria-live polite plus the right semantics.
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('visible'), 2000);
}

/** Simple debounce. */
export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/* ── Releve formatting ────────────────────────────────────────
 * One rule: a number's format encodes what kind of number it is. Money always
 * carries a $ and two decimals so two totals are comparable; token counts are
 * abbreviated because nobody reads 26,221,862,082; a ratio is a percent.
 */

/**
 * What a cell with no value reads as. A word, not a dash: this page's whole
 * argument is that an absent number is different from a zero, and a glyph a
 * reader has to interpret is a poor way to say so. Defined once so no widget
 * invents its own placeholder.
 */
export const NO_VALUE = 'none';

/** Money, always two decimals. Tiny non-zero amounts round up to $0.01 rather
 *  than displaying as $0.00, which reads as "free" and is the wrong claim. */
export function money(v) {
  if (v == null || Number.isNaN(v)) return NO_VALUE;
  if (v > 0 && v < 0.005) return '<$0.01';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Money without cents, for headline figures where cents are noise. */
export function money0(v) {
  if (v == null || Number.isNaN(v)) return NO_VALUE;
  if (Math.abs(v) < 1000) return money(v);
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

/** Abbreviated count: 26,221,862,082 -> 26.2B. */
export function big(v) {
  if (v == null || Number.isNaN(v)) return NO_VALUE;
  const n = Math.abs(v);
  if (n >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}

/** Exact count with separators, for anything a person might reconcile. */
export function count(v) {
  return v == null ? NO_VALUE : v.toLocaleString('en-US');
}

/** A ratio 0..1 as a percent. */
export function pct(v, digits = 1) {
  if (v == null || Number.isNaN(v)) return NO_VALUE;
  return `${(v * 100).toFixed(digits)}%`;
}

/** A multiple: 7.4x. */
export function mult(v) {
  if (v == null || !Number.isFinite(v)) return NO_VALUE;
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)}×`;
}

/** ISO date -> "12 Aug", for axis ticks. */
export function shortDate(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(d)} ${months[Number(m) - 1] || ''}`;
}

/** Shorten a model id for a chart label: claude-opus-4-8 -> opus-4-8. */
export function shortModel(id) {
  return String(id || '').replace(/^claude-/, '').replace(/^us\.anthropic\./, '');
}

/** Copy text, reporting the outcome rather than assuming it worked. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Offer an object as a download. Used by Export view. */
export function downloadJson(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Clamp, because every slider in the projector needs it. */
export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
