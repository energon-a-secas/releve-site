// ── The printable statement ──────────────────────────────────
// Section 1 through 4 and 7, laid out as a document rather than as an app, and
// handed to the browser's own print pipeline. "Save as PDF" in that dialog is
// the export.
//
// Why print and not a PDF library: this page has no build step and makes no
// network call it has not declared, and the two ways to write real PDF bytes in
// a browser are a ~300 KB dependency or a server. Both cost more than the
// feature is worth, and a server would mean uploading the one thing this site
// promises never to upload. The print pipeline is already installed, already
// paginates, already embeds fonts, and already offers a file.
//
// This module owns the lifecycle only: when the document is built, when the
// page is handed over to it, and when it is put back. What the document
// actually says lives in js/report-doc.js.
//
// It is a separate document, not the page restyled. A print stylesheet over the
// live DOM would carry the rail, the sliders, the drop zones and the eight
// section leads onto paper, and would still be missing the one thing a report
// needs: a masthead saying what window, what dataset, and priced how.

import { buildDocument } from './report-doc.js';

/* ── Entry point ────────────────────────────────────────────── */

/** The report container, or null on a page that has none. */
function host() {
  return document.getElementById('report');
}

/** Build the report into the container and put the page into print mode.
 *  A no-op when it is already built, so the button and Cmd+P cannot stack. */
function open_(state) {
  const el = host();
  if (!el || !state.derived || !el.hidden) return !!(el && !el.hidden);
  el.innerHTML = buildDocument(state, state.derived);
  // aria-hidden comes off with `hidden`, and for the same reason: while the
  // dialog is up this is the document, and a print preview driven by a screen
  // reader has to be able to reach it. Both go back on the way out.
  el.hidden = false;
  el.removeAttribute('aria-hidden');
  document.body.classList.add('printing');
  return true;
}

/** Put the page back. Safe to call when nothing is open. */
function close_() {
  const el = host();
  document.body.classList.remove('printing');
  if (!el) return;
  el.hidden = true;
  el.setAttribute('aria-hidden', 'true');
  // Several thousand nodes and a handful of inline SVGs. Nothing reads them
  // between prints, and leaving them there costs every later render a bigger
  // document to walk.
  el.innerHTML = '';
}

/**
 * Register the teardown, and make Cmd+P produce the same report the button does.
 *
 * The beforeprint half is progressive and has to be: the print stylesheet only
 * blanks the page when body.printing is set, so a browser that never fires the
 * event prints the page exactly as it did before this module existed, rather
 * than printing nothing. The build is synchronous because the event is, the
 * user agent fires it before rendering the document for print, and that is the
 * whole window there is to write into.
 */
export function wirePrinting(state) {
  window.addEventListener('beforeprint', () => { open_(state); });
  window.addEventListener('afterprint', close_);
}

/**
 * Build the report and open the print dialog, where "Save as PDF" is the export.
 * @returns {boolean} false when there is nothing priced to report on.
 */
export function printReport(state) {
  if (!state.derived || !host()) return false;
  open_(state);

  // Two frames, so layout and the SVG viewBoxes settle before the dialog
  // snapshots the document. Printing in the same tick prints an unlaid-out
  // report.
  //
  // Raced against a timer, because open_() has already hidden the page and
  // every frame between here and the dialog is a frame of blank white. Two
  // frames is ~32ms on a visible tab and over a second on a throttled one,
  // where requestAnimationFrame is squeezed to roughly one a second; the timer
  // caps that at 250ms whatever the tab is doing. Whichever arrives first wins
  // and the other returns.
  let fired = false;
  const go = () => {
    if (fired) return;
    fired = true;
    window.print();
    // Not every browser fires afterprint, and a page left in print mode is a
    // blank page. window.print() is modal, so this timer cannot run until the
    // dialog is gone either way.
    setTimeout(() => {
      if (document.body.classList.contains('printing')) close_();
    }, 800);
  };
  requestAnimationFrame(() => requestAnimationFrame(go));
  setTimeout(go, 250);
  return true;
}
