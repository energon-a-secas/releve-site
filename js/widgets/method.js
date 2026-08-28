// ── Section 8: Method ────────────────────────────────────────
// The section that makes the rest of the page checkable: whether this browser's
// engine agrees with the scripts' engine, what the dataset says about its own
// quality, what is deliberately not measured, and how to reproduce every number
// on your own machine.

import { count, escHtml, pct } from '../utils.js';

const REPO = 'https://github.com/energon-a-secas/releve-site';
const BASE = 'https://releve.neorgon.com/scripts';

/**
 * The parity result from cost.js selfCheck(). This is the one box on the page
 * that is allowed to shout: if the browser and the Python scripts disagree about
 * money, every other number here is unverified.
 */
export function parity(state) {
  const p = state.parity;
  if (!p) {
    return { cls: 'note', html: '<p>Checking this browser\'s pricing engine against '
      + '<code>data/testcases.json</code>.</p>' };
  }
  if (p.ok) {
    return {
      cls: 'note note--good',
      html: `<p><strong>Engine parity: ${count(p.total)} of ${count(p.total)} fixture `
        + 'cases pass.</strong> The pricing engine in this page and the one in '
        + '<code>releve_cost.py</code> are asserted against the same file, so a '
        + 'figure here and a figure from the scripts are the same calculation. The '
        + 'fixture covers a one-hour cache write, a fast-mode turn, an unpriced '
        + 'model, a locally generated turn, a dated price change, both halves of '
        + 'the iterations rule, and which entries count as one billed response.</p>',
    };
  }
  const list = p.failures.slice(0, 6).map((f) => `<li><code>${escHtml(f.name)}</code>: `
    + `${escHtml((f.lines || []).join('; '))}</li>`).join('');
  return {
    cls: 'note note--bad',
    html: `<p><strong>Engine parity failed: ${count(p.failures.length)} of `
      + `${count(p.total)} cases.</strong> Treat every dollar figure on this page as `
      + 'unverified until this is green. The console lists all of them.</p>'
      + `<ul class="prose">${list}</ul>`,
  };
}

/** What the scan recorded about its own reliability. Every one of these is a
 *  count the scanner kept precisely so it would not have to be guessed at here. */
export function quality(state, view) {
  const doc = state.doc;
  const t = doc.totals || {};
  const q = t.quality || {};
  const rows = [
    ['Scanned', `${count(t.files)} transcript files, ${count(t.sessions)} sessions, `
      + `${count(t.turns)} priced turns`],
    ['Window', `${escHtml((doc.window || {}).from || '?')} to `
      + `${escHtml((doc.window || {}).to || '?')}, `
      + `${count((doc.window || {}).days)} days`],
    ['Cache split assumed', q.estimated_cache_split_turns
      ? `${count(q.estimated_cache_split_turns)} turns carried only a flat cache-write `
        + 'counter, so the five-minute TTL was assumed. Those turns would cost 60% '
        + 'more at the one-hour rate.'
      : 'None. Every cache write in this dataset declared its own TTL.'],
    ['Tier assumed', q.tier_assumed_turns
      ? `${count(q.tier_assumed_turns)} turns ran on a service tier with no published `
        + 'flat multiple, and are priced at standard rather than discounted by a guess.'
      : 'None. Every turn ran on a tier with a published multiple.'],
    ['Iterations rule', q.iteration_turns
      ? `${count(q.iteration_turns)} turns carried an iterations array; `
        + `${count(q.multi_iteration_turns)} of those had more than one entry. The `
        + 'array replaces the top-level counters, so neither half is double-counted.'
      : 'No turn in this dataset carried an iterations array.'],
    ['One bill per response', `${count(q.duplicate_turns_skipped)} repeated entries `
      + `collapsed, ${count(q.richer_duplicates_preferred)} of them because a later copy `
      + 'was fuller than the first. A response is written one entry per content block '
      + 'and every copy repeats the same usage, so counting entries rather than '
      + 'responses is how a bill doubles. See rule 6.'],
    ['Unread', `${count(q.malformed_lines)} unparseable lines, `
      + `${count(q.files_unreadable)} files that could not be read. Counted rather `
      + 'than silently dropped.'],
    ['Cache hit ratio', `${pct((doc.calibration || {}).cache_hit_ratio)} of input `
      + 'tokens across the whole dataset came from cache, which is why section 4 '
      + 'exists.'],
  ];
  return `<dl class="deflist">${rows.map(([dt, dd]) => `
    <div><dt>${escHtml(dt)}</dt><dd>${dd}</dd></div>`).join('')}</dl>`;
}

/** Stated limits. A limit you have to discover is a defect; a limit printed next
 *  to the number is a specification. */
export function limits(state, view) {
  const rows = [
    ['Not an invoice', 'Every dollar here is tokens multiplied by a published list '
      + 'rate. Nothing on this page reads a bill, a subscription statement, or the '
      + 'Admin API, so no figure is authoritative billed spend.'],
    ['The plan figure is your input', 'The subscription number is whatever you typed '
      + `in section 6 (currently $${count(state.planCost)}/month), pro-rated across `
      + 'the window by calendar days. It is not read from an account.'],
    ['Cache multipliers are the one unverified constant',
      '1.25&times; for a five-minute write, 2&times; for one hour, 0.1&times; for a '
      + 'read. They are the documented multipliers of base input, and they are not '
      + `checked against a bill here. ${escHtml(ratecardShare(view))}`],
    ['Partner clouds are null, not guessed', 'Bedrock and Vertex rates differ from '
      + 'first-party ones. The rate card declares the dimension and leaves the values '
      + 'null, because a wrong rate presented confidently is worse than a stated gap.'],
    ['Unpriced is not free', 'A model with no published rate has its tokens and turns '
      + 'counted in their own bucket and left out of every total. It is never priced '
      + 'at a similar model\'s rate and never rendered as zero.'],
    ['Thinking tokens are already inside output', 'They are reported as a label, how '
      + 'much of the output was reasoning, and never added to the cost. Adding them '
      + 'would bill the same tokens twice.'],
    ['Repo token counts are estimates, and here is how wrong',
      'Section 5 divides characters by a per-language factor. Those factors are '
      + 'measured, not guessed: an assistant response is written to the transcript '
      + 'one entry per content block, all sharing a <code>message.id</code>, so '
      + 'reassembling the blocks recovers exactly the characters its '
      + '<code>output_tokens</code> paid for. Fitted over 28,698 responses, the '
      + 'table predicts a whole response to a median 20.7% error (p25 12.3%, p75 '
      + '28.4%). What that does not check is the absolute level, since every factor '
      + 'comes from output tokens and a bias common to all of them would not show '
      + 'up. <code>releve-repo.py --tokenizer api</code> counts exactly and settles '
      + 'it; <code>--calibrate</code> refits the table on your own transcripts.'],
    ['Attribution is best-effort', 'Skill, effort, branch and project labels are '
      + 'whatever the transcript recorded. A turn with no label is grouped under '
      + '<code>(none)</code> rather than dropped.'],
  ];
  return rows.map(([dt, dd]) => `<div><dt>${escHtml(dt)}</dt><dd>${dd}</dd></div>`).join('');
}

function ratecardShare(view) {
  if (!view || !view.cache) return '';
  const c = view.cache.cost;
  const share = c.total ? (c.cache_read + c.cache_write) / c.total : 0;
  return `In this window they decide ${pct(share)} of the total.`;
}

const SCRIPTS = [
  {
    file: 'releve-mini.py',
    title: 'releve-mini.py',
    blurb: 'One number, about a hundred lines, readable in a sitting. The direct '
      + 'answer to "what did this cost?".',
    cmd: 'curl -O https://releve.neorgon.com/scripts/releve-mini.py\npython3 releve-mini.py --days 30',
  },
  {
    file: 'releve-scan.py',
    title: 'releve-scan.py',
    blurb: 'The full engine. Walks every transcript, including the subagent files a '
      + 'one-level glob misses, and writes the releve.json this page loads. Add '
      + '<code>--anonymize</code> before sharing the result.',
    cmd: 'curl -O https://releve.neorgon.com/scripts/releve-scan.py\n'
      + 'curl -O https://releve.neorgon.com/scripts/releve_cost.py\n'
      + 'python3 releve-scan.py --days 30 --out releve.json',
  },
  {
    file: 'releve-repo.py',
    title: 'releve-repo.py',
    blurb: 'Counts and prices a codebase, and projects a stretch of work forward '
      + 'from a releve.json\'s measured medians. <code>--tokenizer api</code> counts '
      + 'exactly; <code>--calibrate</code> refits the per-language factors on your '
      + 'own transcripts and prints the error it achieves.',
    cmd: 'curl -O https://releve.neorgon.com/scripts/releve-repo.py\n'
      + 'curl -O https://releve.neorgon.com/scripts/releve_cost.py\n'
      + 'curl -O https://releve.neorgon.com/data/tokenizer.json\n'
      + 'python3 releve-repo.py . --out releve-repo.json\n'
      + 'python3 releve-repo.py . --project --iterations 40 --from releve.json',
  },
  {
    file: 'releve_cost.py',
    title: 'releve_cost.py',
    blurb: 'The pricing engine the other two import, and the twin of '
      + '<code>js/cost.js</code>. Both are asserted against the same fixture, which '
      + 'is what the box at the top of this section reports.',
    cmd: 'curl -O https://releve.neorgon.com/scripts/releve_cost.py\n'
      + 'python3 -m unittest discover  # or: python3 test_cost.py',
  },
];

export function scriptList() {
  return SCRIPTS.map((s) => `
    <div class="stack stack--tight">
      <p class="prose" style="margin:0">
        <a href="${BASE}/${escHtml(s.file)}"><strong>${escHtml(s.title)}</strong></a>
        &middot; <a href="${REPO}/blob/main/scripts/${escHtml(s.file)}"
          target="_blank" rel="noopener noreferrer">read the source</a><br>
        ${s.blurb}
      </p>
      <div class="cmd"><code>${escHtml(s.cmd)}</code>
        <button class="btn btn--ghost btn--sm cmd__copy" data-copy>Copy</button></div>
    </div>`).join('');
}
