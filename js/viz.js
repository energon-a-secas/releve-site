/* ══════════════════════════════════════════════════════════════
 * @neorgon/ui — Viz Kit builders
 *
 * Dependency-free, framework-free. Every builder is a PURE function that
 * returns an HTML/SVG string, mirroring the proven radar-site render style.
 * Pair with css/viz.css.
 *
 * Shared opts (all optional):
 *   uid        unique id prefix for <defs> (auto-generated if omitted — always
 *              pass a stable one when you need deterministic output/tests)
 *   title      small uppercase heading rendered in a .viz-head frame
 *   scale      right-aligned mono readout in the .viz-head frame
 *   ariaLabel  accessible name for the chart (defaults to title)
 *   width,height  SVG viewBox size (charts are responsive via width:100%)
 *   colors     categorical palette override (array of CSS colors)
 *   animate    true to enable the chart's tasteful, reduced-motion-gated effect
 *   frame      false to skip the .viz-panel wrapper (embed raw SVG)
 * ════════════════════════════════════════════════════════════ */

const PALETTE = [
  'var(--viz-c1)', 'var(--viz-c2)', 'var(--viz-c3)', 'var(--viz-c4)',
  'var(--viz-c5)', 'var(--viz-c6)', 'var(--viz-c7)', 'var(--viz-c8)',
];

let _uidSeq = 0;
const uid = (p = 'viz') => `${p}-${(_uidSeq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const fmt = (n) => (Math.abs(n) >= 1000 ? n.toLocaleString('en-US') : String(+(+n).toFixed(2)));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const paletteAt = (i, colors) => (colors || PALETTE)[i % (colors || PALETTE).length];

/** Wrap chart body in the standard .viz-panel frame (title + scale). */
function frame(body, o = {}) {
  if (o.frame === false) return body;
  const head = (o.title || o.scale)
    ? `<div class="viz-head">${o.title ? `<span class="viz-title">${esc(o.title)}</span>` : ''}${o.scale ? `<span class="viz-scale">${esc(o.scale)}</span>` : ''}</div>`
    : '';
  return `<div class="viz-panel">${head}${body}</div>`;
}

function svgOpen(w, h, o = {}, extra = '') {
  const label = o.ariaLabel || o.title || 'chart';
  const par = extra || '';
  return `<svg class="viz-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}" ${par}>`;
}

/* ── States ────────────────────────────────────────────────── */
export function skeleton(o = {}) {
  return frame(`<div class="viz-skeleton" style="--viz-skel-h:${o.height || 120}px"></div>`, o);
}
export function empty(msg = 'No data yet', o = {}) {
  return frame(`<div class="viz-empty">${esc(msg)}</div>`, o);
}
export function error(msg = 'Could not load data', o = {}) {
  return frame(`<div class="viz-error">${esc(msg)}</div>`, o);
}

/* ── Stat grid (KPI boxes) ─────────────────────────────────── */
/** items: [{ label, value, delta? }]  delta: number | {value, dir} */
export function statGrid(items = []) {
  if (!items.length) return empty('No stats');
  const cells = items.map((it) => {
    let delta = '';
    if (it.delta != null) {
      const d = typeof it.delta === 'object' ? it.delta.value : it.delta;
      const dir = typeof it.delta === 'object' && it.delta.dir
        ? it.delta.dir
        : (d > 0 ? 'up' : d < 0 ? 'down' : 'flat');
      const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■';
      delta = `<span class="viz-stat__delta viz-stat__delta--${dir}">${arrow} ${esc(fmt(Math.abs(d)))}</span>`;
    }
    return `<div class="viz-stat"><span class="viz-stat__label">${esc(it.label)}</span><span class="viz-stat__value">${esc(String(it.value))}</span>${delta}</div>`;
  }).join('');
  return `<div class="viz-stats">${cells}</div>`;
}

/* ── Bars (vertical) ───────────────────────────────────────── */
/** data: [{ label, value, color? }] ; opts.stacked with value as array + opts.keys
 *  opts.tickEvery: label every Nth bar (default: auto, ~14 labels max) */
export function bars(data = [], o = {}) {
  if (!data.length) return frame(empty('No data', { frame: false }), o);
  const w = o.width || 320, h = o.height || 160;
  const pad = { t: 10, r: 8, b: 22, l: 30 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const stacked = Array.isArray(data[0].value);
  const totals = data.map((d) => stacked ? d.value.reduce((a, b) => a + b, 0) : d.value);
  const max = o.max || Math.max(1, ...totals);
  const n = data.length;
  const gap = pw / n * 0.28;
  const bw = pw / n - gap;
  const yAt = (v) => pad.t + ph - (v / max) * ph;
  // A dense series needs fewer axis labels than it has bars: 90 daily bars
  // render 90 overlapping ticks. Thin the labels, never the bars, and every bar
  // keeps its own tooltip. Up to 14 bars behave exactly as before.
  const every = o.tickEvery || Math.max(1, Math.ceil(n / 14));
  const tickAt = (i, label, cx) => (i % every === 0
    ? `<text class="viz-tick" x="${cx}" y="${h - 8}" text-anchor="middle">${esc(label)}</text>`
    : '');

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const y = pad.t + ph - f * ph;
    return `<line class="viz-grid" x1="${pad.l}" y1="${y.toFixed(1)}" x2="${w - pad.r}" y2="${y.toFixed(1)}"/><text class="viz-tick" x="${pad.l - 4}" y="${(y + 3).toFixed(1)}" text-anchor="end">${fmt(max * f)}</text>`;
  }).join('');

  const cls = o.animate ? ' viz-fx-grow' : '';
  const barsSvg = data.map((d, i) => {
    const x = pad.l + i * (pw / n) + gap / 2;
    if (stacked) {
      let acc = 0;
      const segs = d.value.map((v, k) => {
        const y0 = yAt(acc), y1 = yAt(acc + v); acc += v;
        const color = paletteAt(k, o.colors);
        const key = o.keys ? o.keys[k] : `#${k + 1}`;
        return `<rect class="viz-bar${cls}" x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${(y0 - y1).toFixed(1)}" fill="${color}" rx="1.5"><title>${esc(d.label)} · ${esc(key)}: ${fmt(v)}</title></rect>`;
      }).join('');
      return `${segs}${tickAt(i, d.label, (x + bw / 2).toFixed(1))}`;
    }
    const y = yAt(d.value);
    const color = d.color || paletteAt(i, o.colors);
    return `<rect class="viz-bar${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(pad.t + ph - y).toFixed(1)}" fill="${color}" rx="2"><title>${esc(d.label)}: ${fmt(d.value)}</title></rect>${tickAt(i, d.label, (x + bw / 2).toFixed(1))}`;
  }).join('');

  return frame(`${svgOpen(w, h, o)}${grid}${barsSvg}</svg>`, o);
}

/* ── Line / area ───────────────────────────────────────────── */
/** series: [{ name?, color?, values: number[] | {x,y}[] }] ; opts.area, opts.max, opts.min */
export function line(series = [], o = {}) {
  const list = Array.isArray(series[0]) || typeof series[0] === 'number' ? [{ values: series }] : series;
  if (!list.length || !list[0].values?.length) return frame(empty('No data', { frame: false }), o);
  const w = o.width || 340, h = o.height || 150;
  const pad = { t: 10, r: 8, b: 20, l: 30 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const norm = (vals) => vals.map((v, i) => (typeof v === 'number' ? { x: i, y: v } : v));
  const all = list.flatMap((s) => norm(s.values));
  const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = o.min != null ? o.min : Math.min(0, ...ys);
  const yMax = o.max != null ? o.max : Math.max(1, ...ys);
  const xAt = (x) => pad.l + (xMax === xMin ? 0 : (x - xMin) / (xMax - xMin)) * pw;
  const yAt = (y) => pad.t + ph - ((y - yMin) / (yMax - yMin || 1)) * ph;
  const id = o.uid || uid('line');

  const grid = [0, 0.5, 1].map((f) => {
    const y = pad.t + ph - f * ph;
    return `<line class="viz-grid" x1="${pad.l}" y1="${y.toFixed(1)}" x2="${w - pad.r}" y2="${y.toFixed(1)}"/><text class="viz-tick" x="${pad.l - 4}" y="${(y + 3).toFixed(1)}" text-anchor="end">${fmt(yMin + (yMax - yMin) * f)}</text>`;
  }).join('');

  let defs = '';
  const body = list.map((s, si) => {
    const pts = norm(s.values);
    const color = s.color || paletteAt(si, o.colors);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${xAt(p.x).toFixed(1)} ${yAt(p.y).toFixed(1)}`).join(' ');
    let area = '';
    if (o.area) {
      const gid = `${id}-area-${si}`;
      defs += `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity=".35"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient>`;
      const areaD = `${d} L${xAt(pts[pts.length - 1].x).toFixed(1)} ${(pad.t + ph).toFixed(1)} L${xAt(pts[0].x).toFixed(1)} ${(pad.t + ph).toFixed(1)} Z`;
      area = `<path d="${areaD}" fill="url(#${gid})" class="${o.animate ? 'viz-fx-area-in' : ''}"/>`;
    }
    const drawCls = o.animate ? ' viz-fx-draw' : '';
    const drawStyle = o.animate ? ` style="--viz-len:${Math.round(pw + ph)}"` : '';
    const path = `<path d="${d}" class="viz-line${drawCls}" stroke="${color}"${drawStyle}/>`;
    const title = s.name ? `<title>${esc(s.name)}</title>` : '';
    return `<g>${title}${area}${path}</g>`;
  }).join('');

  return frame(`${svgOpen(w, h, o)}<defs>${defs}</defs>${grid}${body}</svg>`, o);
}

/* ── Sparkline (inline, no axes) ───────────────────────────── */
/** values: number[] — tiny trend for tables/rows */
export function spark(values = [], o = {}) {
  if (!values.length) return '';
  const w = o.width || 90, h = o.height || 24, pad = 2;
  const min = Math.min(...values), max = Math.max(...values);
  const xAt = (i) => pad + (values.length <= 1 ? 0 : i / (values.length - 1)) * (w - pad * 2);
  const yAt = (v) => pad + (max === min ? 0.5 : 1 - (v - min) / (max - min)) * (h - pad * 2);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`).join(' ');
  const color = o.color || 'var(--viz-accent-bright)';
  const last = `<circle cx="${xAt(values.length - 1).toFixed(1)}" cy="${yAt(values[values.length - 1]).toFixed(1)}" r="1.8" fill="${color}"/>`;
  return `<svg class="viz-svg" style="width:${w}px;display:inline-block;vertical-align:middle" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(o.ariaLabel || 'trend')}"><path d="${d}" class="viz-line" stroke="${color}" style="stroke-width:1.4"/>${last}</svg>`;
}

/* ── Radar / spider ────────────────────────────────────────── */
/** axes: [{key,label}] ; series: [{name?,color?,values: {key:0..max} | number[]}] */
export function radar(axes = [], series = [], o = {}) {
  if (!axes.length) return frame(empty('No axes', { frame: false }), o);
  const list = Array.isArray(series) ? series : [series];
  const size = o.size || 300, cx = size / 2, cy = size / 2, r = o.r || 92;
  const max = o.max || 100, n = axes.length, pad = 56;
  const angle = (i) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const pt = (i, frac) => [cx + Math.cos(angle(i)) * r * frac, cy + Math.sin(angle(i)) * r * frac];

  const rings = [0.25, 0.5, 0.75, 1].map((f) =>
    `<polygon class="viz-radar-ring" points="${axes.map((_, i) => pt(i, f).map((v) => v.toFixed(1)).join(',')).join(' ')}"/>`
  ).join('');
  const spokes = axes.map((_, i) => {
    const [x, y] = pt(i, 1);
    return `<line class="viz-radar-spoke" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
  }).join('');
  const labels = axes.map((a, i) => {
    const [x, y] = pt(i, 1.16);
    const dx = x - cx;
    const anchor = dx > 8 ? 'start' : dx < -8 ? 'end' : 'middle';
    return `<text class="viz-label" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle">${esc(a.label)}</text>`;
  }).join('');
  const areas = list.map((s, si) => {
    const color = s.color || paletteAt(si, o.colors);
    const val = (a, i) => (Array.isArray(s.values) ? s.values[i] : (s.values[a.key] || 0));
    const pts = axes.map((a, i) => pt(i, clamp(val(a, i) / max, 0, 1)).map((v) => v.toFixed(1)).join(',')).join(' ');
    return `<polygon class="viz-radar-area" points="${pts}" fill="${color}" stroke="${color}"><title>${esc(s.name || 'series')}</title></polygon>`;
  }).join('');

  return frame(`<svg class="viz-svg" viewBox="${-pad} 0 ${size + pad * 2} ${size}" role="img" aria-label="${esc(o.ariaLabel || o.title || 'radar chart')}">${rings}${spokes}${areas}${labels}</svg>`, o);
}

/* ── Gauge / progress ring / band meter ────────────────────── */
/** value 0..max ; opts.mode 'ring' | 'band' ; opts.bands (band mode) */
export function gauge(value = 0, o = {}) {
  const max = o.max || 100, v = clamp(value, 0, max), frac = v / max;
  const color = o.color || 'var(--viz-accent-bright)';
  if (o.mode === 'band') {
    const w = o.width || 260, h = o.height || 34, pad = 6, bw = w - pad * 2;
    const bands = o.bands || [{ to: max, color }];
    let acc = 0;
    const segs = bands.map((b) => {
      const x0 = pad + (acc / max) * bw, x1 = pad + (b.to / max) * bw; acc = b.to;
      return `<rect x="${x0.toFixed(1)}" y="${(h / 2 - 4).toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="8" fill="${b.color}" opacity=".55"/>`;
    }).join('');
    const mx = pad + frac * bw;
    const marker = `<line x1="${mx.toFixed(1)}" y1="4" x2="${mx.toFixed(1)}" y2="${h - 12}" stroke="var(--viz-ink)" stroke-width="2"/><circle cx="${mx.toFixed(1)}" cy="4" r="3" fill="var(--viz-ink)"/>`;
    return frame(`${svgOpen(w, h, o)}${segs}${marker}<text class="viz-tick" x="${pad}" y="${h - 1}">0</text><text class="viz-tick" x="${w - pad}" y="${h - 1}" text-anchor="end">${fmt(max)}</text></svg>`, o);
  }
  // ring mode (270° arc)
  const size = o.size || 120, cx = size / 2, cy = size / 2, rr = size / 2 - 12;
  const start = 135, sweep = 270;
  const polar = (deg) => [cx + rr * Math.cos((deg * Math.PI) / 180), cy + rr * Math.sin((deg * Math.PI) / 180)];
  const arc = (fromDeg, toDeg) => {
    const [x0, y0] = polar(fromDeg), [x1, y1] = polar(toDeg);
    const large = (toDeg - fromDeg) % 360 > 180 ? 1 : 0;
    return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${rr} ${rr} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  };
  const track = `<path class="viz-gauge-track" d="${arc(start, start + sweep)}" stroke-width="${o.thickness || 10}"/>`;
  const drawCls = o.animate ? ' viz-fx-draw' : '';
  const len = (sweep / 360) * 2 * Math.PI * rr;
  const style = o.animate ? ` style="--viz-len:${Math.round(len)}"` : '';
  const fill = frac > 0 ? `<path class="viz-gauge-fill${drawCls}" d="${arc(start, start + sweep * frac)}" stroke="${color}" stroke-width="${o.thickness || 10}"${style}/>` : '';
  const label = `<text class="viz-gauge-value" x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="${size / 5}">${o.label != null ? esc(o.label) : fmt(v)}</text>`;
  return frame(`<svg class="viz-svg" style="max-width:${size}px;margin:0 auto" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(o.ariaLabel || o.title || 'gauge')} ${fmt(v)} of ${fmt(max)}">${track}${fill}${label}</svg>`, o);
}

/* ── Donut / distribution ──────────────────────────────────── */
/** segments: [{label, value, color?}] */
export function donut(segments = [], o = {}) {
  const segs = segments.filter((s) => s.value > 0);
  if (!segs.length) return frame(empty('No data', { frame: false }), o);
  const size = o.size || 140, cx = size / 2, cy = size / 2;
  const rr = size / 2 - 8, thick = o.thickness || 16, cr = 2 * Math.PI * rr;
  const total = segs.reduce((a, s) => a + s.value, 0);
  let acc = 0;
  const ring = segs.map((s, i) => {
    const frac = s.value / total, dash = frac * cr, off = acc * cr; acc += frac;
    const color = s.color || paletteAt(i, o.colors);
    return `<circle class="viz-donut-seg" cx="${cx}" cy="${cy}" r="${rr}" fill="none" stroke="${color}" stroke-width="${thick}" stroke-dasharray="${dash.toFixed(2)} ${(cr - dash).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"><title>${esc(s.label)}: ${fmt(s.value)} (${Math.round(frac * 100)}%)</title></circle>`;
  }).join('');
  const center = o.center != null
    ? `<text class="viz-donut-center" x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="${size / 6}">${esc(o.center)}</text>`
    : '';
  const legend = o.legend
    ? `<div class="viz-stats" style="margin-top:8px">${segs.map((s, i) => `<div class="viz-stat" style="flex:0 1 auto;flex-direction:row;align-items:center;gap:6px;padding:4px 8px"><span style="width:8px;height:8px;border-radius:2px;background:${s.color || paletteAt(i, o.colors)}"></span><span class="viz-stat__label" style="letter-spacing:0">${esc(s.label)}</span></div>`).join('')}</div>`
    : '';
  return frame(`<svg class="viz-svg" style="max-width:${size}px;margin:0 auto" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(o.ariaLabel || o.title || 'distribution')}">${ring}${center}</svg>${legend}`, o);
}

/* ── Heatmap / density grid ────────────────────────────────── */
/** grid: number[][] (rows of values) ; opts.max, opts.cols, opts.rows (labels) */
export function heatmap(grid = [], o = {}) {
  if (!grid.length) return frame(empty('No data', { frame: false }), o);
  const rows = grid.length, cols = Math.max(...grid.map((r) => r.length));
  const cell = o.cell || 16, gap = o.gap || 2, lp = o.rows ? 34 : 0, tp = o.cols ? 14 : 0;
  const w = lp + cols * (cell + gap), h = tp + rows * (cell + gap);
  const max = o.max || Math.max(1, ...grid.flat());
  const ramp = ['var(--viz-heat-0)', 'var(--viz-heat-1)', 'var(--viz-heat-2)', 'var(--viz-heat-3)', 'var(--viz-heat-4)'];
  const colorFor = (v) => (v == null ? 'transparent' : ramp[clamp(Math.round((v / max) * (ramp.length - 1)), 0, ramp.length - 1)]);
  let cells = '';
  grid.forEach((row, r) => {
    row.forEach((v, c) => {
      const x = lp + c * (cell + gap), y = tp + r * (cell + gap);
      const label = `${o.rows ? o.rows[r] + ' · ' : ''}${o.cols ? o.cols[c] + ': ' : ''}${fmt(v)}`;
      cells += `<rect class="viz-cell" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${colorFor(v)}"><title>${esc(label)}</title></rect>`;
    });
  });
  const rowLabels = o.rows ? o.rows.map((l, r) => `<text class="viz-tick" x="${lp - 5}" y="${tp + r * (cell + gap) + cell / 2 + 3}" text-anchor="end">${esc(l)}</text>`).join('') : '';
  const colLabels = o.cols ? o.cols.map((l, c) => `<text class="viz-tick" x="${lp + c * (cell + gap) + cell / 2}" y="${tp - 4}" text-anchor="middle">${esc(l)}</text>`).join('') : '';
  return frame(`${svgOpen(w, h, o)}${rowLabels}${colLabels}${cells}</svg>`, o);
}

/* ── Timeline / stem / event strip ─────────────────────────── */
/** events: [{t, value, color?, label?, marked?}] ; opts.from,to (ms), opts.ref{value,label}, opts.maxValue */
export function timeline(events = [], o = {}) {
  if (!events.length) return frame(empty('No events', { frame: false }), o);
  const w = o.width || 300, h = o.height || 78;
  const padX = 6, padTop = 8, baseY = h - 16, pw = w - padX * 2;
  const to = o.to || Date.now();
  const from = o.from || Math.min(...events.map((e) => e.t));
  const span = Math.max(1, to - from);
  const maxV = o.maxValue || Math.max(1, ...events.map((e) => e.value));
  const xAt = (t) => padX + ((t - from) / span) * pw;
  const yAt = (v) => baseY - (v / maxV) * (baseY - padTop);

  const stems = events.filter((e) => e.t >= from && e.t <= to).map((e) => {
    const x = xAt(e.t).toFixed(1), y = yAt(e.value).toFixed(1);
    const color = e.color || 'var(--viz-accent-bright)';
    const halo = e.marked ? `<circle cx="${x}" cy="${y}" r="4.5" fill="none" stroke="${color}" stroke-width="1.4" opacity=".9"/>` : '';
    return `<line x1="${x}" y1="${baseY}" x2="${x}" y2="${y}" stroke="${color}" stroke-width="2" stroke-linecap="round" opacity=".85"/><circle cx="${x}" cy="${y}" r="2.6" fill="${color}"><title>${esc(e.label || fmt(e.value))}</title></circle>${halo}`;
  }).join('');

  let ref = '';
  if (o.ref) {
    const ry = yAt(o.ref.value).toFixed(1);
    ref = `<line class="viz-ref" x1="${padX}" y1="${ry}" x2="${w - padX}" y2="${ry}"/>${o.ref.label ? `<text class="viz-tick" x="${w - padX}" y="${Number(ry) - 3}" text-anchor="end">${esc(o.ref.label)}</text>` : ''}`;
  }
  return frame(`${svgOpen(w, h, o, 'preserveAspectRatio="none"')}<line class="viz-axis" x1="${padX}" y1="${baseY}" x2="${w - padX}" y2="${baseY}"/>${ref}${stems}</svg>`, o);
}

/* ── Dense series (canvas) — ports hwinfo-viewer decimation ─────── */
/** Draw a min/max-per-pixel decimated line into a <canvas> for huge series. */
export function canvasLine(canvas, values, o = {}) {
  if (!canvas || !values?.length) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(160, rect.width), h = rect.height || 120;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const pad = { t: 6, r: 6, b: 6, l: 6 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const min = o.min != null ? o.min : Math.min(...values);
  const max = o.max != null ? o.max : Math.max(...values);
  const span = max - min || 1;
  const yAt = (v) => pad.t + ph - ((v - min) / span) * ph;
  const n = values.length, cols = Math.max(1, Math.floor(pw));
  ctx.beginPath();
  if (n <= cols) {
    values.forEach((v, i) => {
      const x = pad.l + (n <= 1 ? 0 : (i / (n - 1)) * pw);
      i ? ctx.lineTo(x, yAt(v)) : ctx.moveTo(x, yAt(v));
    });
  } else {
    const bucket = n / cols;
    for (let b = 0; b < cols; b++) {
      const s0 = Math.floor(b * bucket), s1 = Math.min(n, Math.floor((b + 1) * bucket));
      let lo = Infinity, hi = -Infinity;
      for (let i = s0; i < s1; i++) { if (values[i] < lo) lo = values[i]; if (values[i] > hi) hi = values[i]; }
      const x = pad.l + (b / (cols - 1 || 1)) * pw;
      b ? ctx.lineTo(x, yAt(hi)) : ctx.moveTo(x, yAt(hi));
      ctx.lineTo(x, yAt(lo));
    }
  }
  ctx.strokeStyle = o.color || getComputedStyle(document.documentElement).getPropertyValue('--viz-accent-bright') || '#0080ff';
  ctx.lineWidth = 1.4; ctx.lineJoin = 'round';
  ctx.stroke();
}

export const viz = {
  statGrid, bars, line, spark, radar, gauge, donut, heatmap, timeline,
  canvasLine, skeleton, empty, error,
};
export default viz;
