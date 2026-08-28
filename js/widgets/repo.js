// ── Section 5: Repo scanner ──────────────────────────────────
// What a codebase costs to put in front of a model, and how much of the context
// window it fills. Two ways in: a releve-repo.json from the script, or a folder
// picked here and counted in the browser.
//
// The tokenizer question is the whole accuracy story. tiktoken, which both of
// the tools this section was compared against use, is an OpenAI tokenizer and
// does not describe Claude's. So this counts characters and divides by a
// per-language factor from data/tokenizer.json, and says out loud that the
// factor is an estimate. The exact answer comes from
// client.messages.count_tokens, which needs a key, which a static page does not
// have. An estimate labelled as one beats a wrong number labelled as exact.

import { bars, statGrid } from '../viz.js';
import { publishedPair } from '../rates.js';
import {
  big, count, escHtml, money, NO_VALUE, pct, shortModel,
} from '../utils.js';

const SCHEMA = 'releve-repo/v1';

let tokenizer = null;

export async function loadTokenizer(url = 'data/tokenizer.json') {
  if (tokenizer) return tokenizer;
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`tokenizer table: HTTP ${res.status}`);
  tokenizer = await res.json();
  return tokenizer;
}

export function validate(doc) {
  if (!doc || doc.schema !== SCHEMA) {
    throw new Error(`expected schema "${SCHEMA}", found ${JSON.stringify(doc && doc.schema)}`);
  }
  if (!doc.languages) throw new Error('missing "languages"');
  return doc;
}

// ── In-browser count ─────────────────────────────────────────

function classify(name, table) {
  const base = name.split('/').pop();
  if (table.filenames[base]) return table.filenames[base];
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = base.slice(dot).toLowerCase();
  if (table.skip_extensions.includes(ext)) return false;   // deliberately skipped
  return table.extensions[ext] || null;                     // null = unknown text
}

/**
 * Count a folder the visitor picked. Reads every file locally; uploads nothing.
 * @param {FileList} files from an <input webkitdirectory>
 */
export async function countFolder(files, table) {
  const langs = new Map();
  const biggest = [];
  const skipped = { binary: 0, ignored: 0, too_large: 0, unknown: 0 };
  let bytes = 0;

  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    if (path.split('/').some((part) => table.skip_dirs.includes(part))) {
      skipped.ignored += 1;
      continue;
    }
    const lang = classify(path, table);
    if (lang === false) { skipped.binary += 1; continue; }
    if (lang === null) { skipped.unknown += 1; continue; }
    if (file.size > table.max_file_bytes) { skipped.too_large += 1; continue; }

    // Character count, not byte count: a factor of chars-per-token has to be
    // applied to characters, and a UTF-8 byte count overstates any non-ASCII file.
    const text = await file.text();
    const chars = text.length;
    const factor = table.languages[lang] || table.default;
    const tokens = Math.round(chars / factor);

    bytes += file.size;
    const slot = langs.get(lang) || { language: lang, files: 0, bytes: 0, chars: 0, tokens: 0 };
    slot.files += 1;
    slot.bytes += file.size;
    slot.chars += chars;
    slot.tokens += tokens;
    langs.set(lang, slot);
    biggest.push({ path, language: lang, bytes: file.size, tokens });
  }

  biggest.sort((a, b) => b.tokens - a.tokens);
  const languages = [...langs.values()].sort((a, b) => b.tokens - a.tokens);
  const tokens = languages.reduce((s, l) => s + l.tokens, 0);

  return {
    schema: SCHEMA,
    generated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    generator: 'js/widgets/repo.js in the browser',
    root: (files[0] && (files[0].webkitRelativePath || '').split('/')[0]) || 'folder',
    tokenizer: {
      mode: 'calibrated',
      note: `Characters divided by the per-language factors in data/tokenizer.json, `
        + `measured ${table.verified}. An estimate, not a tokenizer: median error `
        + `${((table.error_bar || 0) * 100).toFixed(0)}% on a whole response. `
        + 'releve-repo.py --tokenizer api counts exactly.',
      error_bar: table.error_bar,
      error_bar_note: table.error_bar_note,
      table_verified: table.verified,
    },
    totals: {
      files: languages.reduce((s, l) => s + l.files, 0),
      bytes,
      chars: languages.reduce((s, l) => s + l.chars, 0),
      tokens,
    },
    languages,
    files: biggest.slice(0, 40),
    skipped,
  };
}

// ── Render ───────────────────────────────────────────────────

export function render(repo, state, view) {
  if (!repo) {
    return '<div class="viz-panel"><div class="viz-empty">No repository loaded. '
      + 'Run the script, or pick a folder above.</div></div>';
  }

  const models = pricedModels(state, view);
  const first = models[0];
  const cost = first ? (repo.totals.tokens * first.input) / 1e6 : null;

  const stats = statGrid([
    { label: 'Files counted', value: count(repo.totals.files) },
    { label: 'Tokens', value: big(repo.totals.tokens) },
    { label: first ? `Once, as ${shortModel(first.name)} input` : 'Cost', value: cost == null ? NO_VALUE : money(cost) },
    { label: 'Languages', value: count(repo.languages.length) },
  ]);

  const top = repo.languages.slice(0, 12);
  const chart = bars(top.map((l) => ({ label: l.language.slice(0, 12), value: l.tokens })), {
    width: 760,
    height: 190,
    title: 'Tokens by language',
    scale: `${big(repo.totals.tokens)} in ${count(repo.totals.files)} files`,
    ariaLabel: 'Tokens by language',
    animate: true,
  });

  return `${stats}${chart}${contextTable(repo, models)}${languageTable(repo, models)}
    ${provenance(repo)}`;
}

/** Priced models with a context window, in the order the rate card lists them. */
function pricedModels(state, view) {
  const out = [];
  for (const [name, model] of Object.entries((view.rates || {}).models || {})) {
    if (model.excluded || !(model.periods || []).length) continue;
    const pair = publishedPair(view.rates, name);
    if (!pair) continue;
    out.push({ name, input: pair.input, output: pair.output, context: model.context || null });
  }
  return out;
}

/** The question the reference tools answer badly: does this repo even fit? */
function contextTable(repo, models) {
  const rows = models.filter((m) => m.context).map((m) => {
    const frac = repo.totals.tokens / m.context;
    const cost = (repo.totals.tokens * m.input) / 1e6;
    return `<tr>
      <td class="table__key"><code>${escHtml(shortModel(m.name))}</code></td>
      <td class="n"><span class="num">${escHtml(big(m.context))}</span></td>
      <td class="n"><span class="num${frac > 1 ? ' num--warn' : ''}">${escHtml(pct(frac, 0))}</span></td>
      <td><span class="rowbar"><i style="width:${Math.min(100, frac * 100).toFixed(1)}%"></i></span></td>
      <td class="n"><span class="num num--money">${escHtml(money(cost))}</span></td>
    </tr>`;
  }).join('');
  if (!rows) return '';
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>Model</th><th class="n">Context</th><th class="n">Repo fills</th>
      <th>&nbsp;</th><th class="n">Cost, once</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function languageTable(repo, models) {
  const rate = models.length ? models[0].input : null;
  const total = repo.totals.tokens || 1;
  const rows = repo.languages.map((l) => `<tr>
      <td>${escHtml(l.language)}</td>
      <td class="n"><span class="num">${escHtml(count(l.files))}</span></td>
      <td class="n"><span class="num">${escHtml(big(l.tokens))}</span></td>
      <td class="n"><span class="num num--muted">${escHtml(pct(l.tokens / total))}</span></td>
      <td class="n"><span class="num num--money">${rate == null ? NO_VALUE
    : escHtml(money((l.tokens * rate) / 1e6))}</span></td>
    </tr>`).join('');
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>Language</th><th class="n">Files</th><th class="n">Tokens</th>
      <th class="n">Share</th><th class="n">Cost, once</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function provenance(repo) {
  const s = repo.skipped || {};
  const skipped = Object.entries(s).filter(([, v]) => v)
    .map(([k, v]) => `${count(v)} ${k.replace(/_/g, ' ')}`).join(', ');
  const mode = (repo.tokenizer || {}).mode || 'unknown';
  const exact = mode === 'api';
  return `<div class="note${exact ? ' note--good' : ' note--warn'}">
    <p><strong>${escHtml(repo.root || 'folder')}</strong>, counted by
    <code>${escHtml(mode)}</code>. ${exact
    ? 'Exact: every file was counted through the token-counting endpoint.'
    : escHtml((repo.tokenizer || {}).note || 'An estimate from characters per token.')}</p>
    ${skipped ? `<p class="num--muted">Skipped: ${escHtml(skipped)}.</p>` : ''}
    <p class="num--muted">Cost columns price the whole tree as fresh input, once.
    Real work re-reads a subset of it many times, most of that from cache at a
    tenth of the rate, so treat this as the ceiling on a single cold read rather
    than a forecast. Section 6 is the forecast.</p>
  </div>`;
}
