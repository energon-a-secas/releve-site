// ── Entry point ──────────────────────────────────────────────
// Order matters here and nowhere else: the rate card has to exist before
// anything can be priced, and the parity self-check has to run before the page
// claims a dollar figure is trustworthy.

import { state, loadSaved } from './state.js';
import { loadRates } from './rates.js';
import { loadDefault } from './ingest.js';
import { selfCheck } from './cost.js';
import { render, renderFailure } from './render.js';
import { bindEvents, adoptDoc } from './events.js';

async function init() {
  loadSaved(state);
  bindEvents();

  try {
    state.baseRates = await loadRates();
  } catch (err) {
    renderFailure(`No rate card: ${err.message}. Nothing can be priced.`);
    return;
  }

  try {
    const { doc, source } = await loadDefault();
    adoptDoc(doc, source);
  } catch (err) {
    renderFailure(`No dataset: ${err.message}`);
  }

  // Verify the engine against the same fixture the Python side asserts on. A
  // failure is reported in the Method section, not swallowed: two engines that
  // disagree about money make every figure above it meaningless.
  state.parity = await selfCheck(state.baseRates);
  if (!state.parity.ok) {
    console.error('Releve engine parity FAILED', state.parity.failures);
  }
  render(state);
}

init();
