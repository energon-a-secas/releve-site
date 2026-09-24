// ── Pinning ──────────────────────────────────────────────────
// One job: mark the filter bar while it is pinned, so the CSS can give it an
// edge and a shadow it should not have while it is sitting in the flow.
//
// Separate from events.js because it carries none of that module's traffic. It
// mutates no state, calls no render, and reads nothing a visitor typed: it
// watches geometry and writes one attribute.

import { $ } from './utils.js';

/**
 * Tell a pinned filter bar from one still sitting in the flow, and mark it.
 *
 * There is no CSS selector for "this sticky element is currently stuck", so the
 * standard reading is a sentinel: a zero-height marker at the top of the range,
 * watched with the pin offset as a negative top root margin. The moment the
 * sentinel leaves that inset viewport, the bar has reached its offset and
 * pinned. Reading scroll position instead would mean a listener on every frame
 * to compute something the compositor already knows.
 */
export function wirePinning() {
  const bar = $('filters');
  const sentinel = document.querySelector('.scope__sentinel');
  if (!bar || !sentinel || !('IntersectionObserver' in window)) return;

  // Ask the layout where the bar pins rather than repeating the number here.
  // getComputedStyle resolves --filters-top through the calc and the :has()
  // override, so the CSS stays the single place that offset is decided. The
  // fallback covers the one frame before the stylesheet applies, where `top`
  // is still `auto`.
  const offset = () => {
    const px = parseFloat(getComputedStyle(bar).top);
    return Number.isFinite(px) ? px : 64;
  };

  let io = null;
  const observe = () => {
    if (io) io.disconnect();
    io = new IntersectionObserver(([entry]) => {
      // Above the range the sentinel is visible and the bar is in flow. Below
      // it, the bar has been released by .scope and is off screen anyway, so
      // the stuck styling it keeps is never painted.
      bar.dataset.stuck = String(!entry.isIntersecting);
    }, { rootMargin: `-${offset() + 1}px 0px 0px 0px`, threshold: 0 });
    io.observe(sentinel);
  };
  observe();

  // The header's auto-hide moves the pin offset by 56px, which moves the line
  // the observer is watching for, so the margin has to be rebuilt from the new
  // one.
  //
  // After the transition, not on the class flip: `top` is animated, so reading
  // it the moment the class lands returns the offset the bar is leaving rather
  // than the one it is going to, and the observer would spend the rest of the
  // page measuring against a line 56px off. The timer outlasts the .26s
  // transition and still holds when prefers-reduced-motion removes it, where
  // the value settles at once and no transitionend ever arrives.
  const header = document.querySelector('.header-bar');
  if (header && 'MutationObserver' in window) {
    let was = header.classList.contains('header-hidden');
    let settle = null;
    new MutationObserver(() => {
      const now = header.classList.contains('header-hidden');
      if (now === was) return;
      was = now;
      clearTimeout(settle);
      settle = setTimeout(observe, 320);
    }).observe(header, { attributes: true, attributeFilter: ['class'] });
  }
}
