/* charts.js — small hand-rolled SVG chart engine.
   Marks follow the data-viz specs: 2px lines, >=8px end dots with a 2px surface
   ring, <=24px bars with 4px rounded data-ends and a 2px surface gap, hairline
   solid grid, one y-axis per plot (never a second scale), crosshair tooltip on
   lines, per-mark tooltip on bars, a legend whenever two marks share a plot,
   selective end labels, and a table-view twin for every chart. */

const SVG_NS = 'http://www.w3.org/2000/svg';
const MARGIN = { top: 18, right: 54, bottom: 30, left: 46 };

const el = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  return node;
};

const html = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};

const isNum = (v) => v !== null && v !== undefined && Number.isFinite(v);

/** Axis ticks on clean numbers, ~step 1/2/2.5/5 x 10^n. */
function niceTicks(min, max, count = 5) {
  if (!isNum(min) || !isNum(max)) return { ticks: [0, 1], lo: 0, hi: 1 };
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.abs(v) < step / 1e6 ? 0 : v);
  return { ticks, lo, hi };
}

/** Path with a 4px rounded data-end and square corners at the baseline. */
function barPath(x, y, w, h, r = 4) {
  const rr = Math.max(0, Math.min(r, w / 2, Math.abs(h)));
  if (h <= 0.5) return `M${x} ${y}h${w}`;
  return `M${x} ${y + h}V${y + rr}a${rr} ${rr} 0 0 1 ${rr} ${-rr}h${w - 2 * rr}a${rr} ${rr} 0 0 1 ${rr} ${rr}V${y + h}Z`;
}

/* ---------- shared card scaffolding ---------- */

function chartFrame(cfg) {
  const root = html('div', 'card chart-card');
  const head = html('div', 'chart-head');
  const titles = html('div');
  titles.append(html('h3', 'chart-title', cfg.title));
  if (cfg.subtitle) titles.append(html('p', 'chart-sub', cfg.subtitle));
  head.append(titles);
  root.append(head);

  const legendItems = [...(cfg.series || []).filter((s) => !s.hideFromLegend), ...(cfg.band ? [cfg.band] : [])];
  if (legendItems.length >= 2) {
    const legend = html('ul', 'legend');
    for (const item of legendItems) {
      const li = html('li');
      const key = html('span', item.kind === 'rect' || item.lo ? 'key-rect' : 'key-line');
      key.style.background = item.color;
      if (item.lo) key.style.opacity = '0.35';
      li.append(key, html('span', null, item.name));
      legend.append(li);
    }
    root.append(legend);
  }

  const figure = html('figure', 'plot');
  root.append(figure);

  const tooltip = html('div', 'tooltip');
  tooltip.setAttribute('role', 'tooltip');
  root.append(tooltip);

  return { root, figure, tooltip };
}

function showTooltip(tooltip, { title, rows }, x, y, plotWidth) {
  tooltip.replaceChildren();
  tooltip.append(html('div', 'tt-head', title));
  for (const r of rows) {
    const row = html('div', 'tt-row');
    const left = html('span', null);
    const key = html('span', 'tt-key');
    key.style.background = r.color;
    if (r.faint) key.style.opacity = '0.4';
    left.append(key, html('span', 'tt-name', ` ${r.name}`));
    row.append(left, html('span', 'tt-val', r.value));
    tooltip.append(row);
  }
  const clamped = Math.max(90, Math.min(plotWidth - 90, x));
  tooltip.style.left = `${clamped}px`;
  tooltip.style.top = `${Math.max(56, y)}px`;
  tooltip.dataset.show = '1';
}

const hideTooltip = (tooltip) => { tooltip.dataset.show = '0'; };

/** Re-render on width change, so text keeps its true size instead of scaling. */
function responsive(root, figure, draw) {
  let last = 0;
  const run = () => {
    const w = Math.max(320, Math.floor(figure.getBoundingClientRect().width || root.getBoundingClientRect().width || 640));
    if (Math.abs(w - last) < 8) return;
    last = w;
    figure.replaceChildren(draw(w));
  };
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => run());
    ro.observe(figure);
  } else {
    window.addEventListener('resize', run);
  }
  requestAnimationFrame(run);
  run();
}

/* ---------- table-view twin (every chart has one) ---------- */

function tableView(xHeader, xLabels, columns) {
  const details = html('details', 'tableview');
  details.append(html('summary', null, 'Table view (every value, no hover needed)'));
  const wrap = html('div', 'tablewrap');
  const table = html('table', 'data');
  const thead = html('thead');
  const hrow = html('tr');
  hrow.append(html('th', null, xHeader));
  for (const c of columns) hrow.append(html('th', null, c.name));
  thead.append(hrow);
  const tbody = html('tbody');
  xLabels.forEach((label, i) => {
    const tr = html('tr');
    tr.append(html('th', null, label));
    for (const c of columns) tr.append(html('td', null, c.format(c.values[i])));
    tbody.append(tr);
  });
  table.append(thead, tbody);
  wrap.append(table);
  details.append(wrap);
  return details;
}

const spreadIndices = (n, want) => {
  if (n <= want) return [...Array(n).keys()];
  const step = (n - 1) / (want - 1);
  return [...Array(want).keys()].map((i) => Math.round(i * step));
};

/* ---------- line / band chart ---------- */

export function lineChart(cfg) {
  const { root, figure, tooltip } = chartFrame(cfg);
  const height = cfg.height || 260;
  const fmt = cfg.format || ((v) => (isNum(v) ? v.toFixed(1) : '—'));
  const n = cfg.xLabels.length;

  responsive(root, figure, (w) => {
    const pw = w - MARGIN.left - MARGIN.right;
    const ph = height - MARGIN.top - MARGIN.bottom;
    const pool = [
      ...cfg.series.flatMap((s) => s.values),
      ...(cfg.band ? [...cfg.band.lo, ...cfg.band.hi] : []),
    ].filter(isNum);
    const { ticks, lo, hi } = niceTicks(Math.min(...pool), Math.max(...pool), 5);
    const X = (i) => MARGIN.left + (n <= 1 ? pw / 2 : (pw * i) / (n - 1));
    const Y = (v) => MARGIN.top + ph - ((v - lo) / (hi - lo || 1)) * ph;

    const svg = el('svg', {
      viewBox: `0 0 ${w} ${height}`, width: w, height, role: 'img', tabindex: '0',
      'aria-label': cfg.ariaLabel || `${cfg.title}. ${cfg.series.map((s) => s.name).join(', ')}. Use arrow keys to read values.`,
    });

    for (const t of ticks) {
      svg.append(el('line', { class: 'grid-line', x1: MARGIN.left, x2: MARGIN.left + pw, y1: Y(t), y2: Y(t) }));
      const label = el('text', { class: 'tick-text', x: MARGIN.left - 8, y: Y(t) + 4, 'text-anchor': 'end' });
      label.textContent = fmt(t);
      svg.append(label);
    }
    if (cfg.yLabel) {
      const yl = el('text', { class: 'axis-title', x: MARGIN.left - 8, y: MARGIN.top - 8, 'text-anchor': 'end' });
      yl.textContent = cfg.yLabel;
      svg.append(yl);
    }
    svg.append(el('line', { class: 'axis-line', x1: MARGIN.left, x2: MARGIN.left + pw, y1: MARGIN.top + ph, y2: MARGIN.top + ph }));

    for (const i of spreadIndices(n, Math.max(2, Math.min(8, Math.floor(pw / 90))))) {
      const tick = el('text', { class: 'tick-text', x: X(i), y: height - 10, 'text-anchor': 'middle' });
      tick.textContent = cfg.xTickLabels ? cfg.xTickLabels[i] : cfg.xLabels[i];
      svg.append(tick);
    }

    if (cfg.band) {
      const pts = [];
      const back = [];
      for (let i = 0; i < n; i += 1) {
        if (isNum(cfg.band.hi[i]) && isNum(cfg.band.lo[i])) {
          pts.push(`${X(i)},${Y(cfg.band.hi[i])}`);
          back.unshift(`${X(i)},${Y(cfg.band.lo[i])}`);
        }
      }
      if (pts.length) {
        svg.append(el('path', {
          d: `M${pts.join('L')}L${back.join('L')}Z`, fill: cfg.band.color, 'fill-opacity': 0.1, stroke: 'none',
        }));
      }
    }

    for (const s of cfg.series) {
      let d = '';
      let open = false;
      for (let i = 0; i < n; i += 1) {
        if (isNum(s.values[i])) { d += `${open ? 'L' : 'M'}${X(i)},${Y(s.values[i])}`; open = true; } else { open = false; }
      }
      if (d) svg.append(el('path', { class: 'mark-line', d, stroke: s.color }));
    }

    const ends = cfg.series.map((s) => {
      for (let i = n - 1; i >= 0; i -= 1) if (isNum(s.values[i])) return { s, i, v: s.values[i] };
      return null;
    }).filter(Boolean);
    const placed = [];
    for (const e of ends) {
      const y = Y(e.v);
      svg.append(el('circle', { class: 'mark-dot', cx: X(e.i), cy: y, r: 4.5, fill: e.s.color }));
      if (cfg.endLabels !== false && !placed.some((py) => Math.abs(py - y) < 13)) {
        const label = el('text', { class: 'point-label', x: Math.min(X(e.i) + 8, w - 4), y: y + 4 });
        label.textContent = fmt(e.v);
        svg.append(label);
        placed.push(y);
      }
    }

    const cross = el('line', { class: 'crosshair', y1: MARGIN.top, y2: MARGIN.top + ph, x1: 0, x2: 0, visibility: 'hidden' });
    const focusDots = cfg.series.map((s) => el('circle', { class: 'mark-dot', r: 4.5, fill: s.color, visibility: 'hidden' }));
    svg.append(cross, ...focusDots);

    const move = (i, clientY) => {
      if (!Number.isInteger(i) || i < 0 || i >= n) return;
      cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('visibility', 'visible');
      cfg.series.forEach((s, k) => {
        const dot = focusDots[k];
        if (isNum(s.values[i])) {
          dot.setAttribute('cx', X(i)); dot.setAttribute('cy', Y(s.values[i])); dot.setAttribute('visibility', 'visible');
        } else dot.setAttribute('visibility', 'hidden');
      });
      const rows = cfg.series.map((s) => ({ name: s.name, color: s.color, value: isNum(s.values[i]) ? fmt(s.values[i]) : '—' }));
      if (cfg.band) {
        rows.push({
          name: cfg.band.name, color: cfg.band.color, faint: true,
          value: isNum(cfg.band.lo[i]) && isNum(cfg.band.hi[i]) ? `${fmt(cfg.band.lo[i])} – ${fmt(cfg.band.hi[i])}` : '—',
        });
      }
      showTooltip(tooltip, { title: cfg.xLabels[i], rows }, X(i), clientY ?? Y(cfg.series[0].values[i] ?? lo), w);
    };

    let hoverIndex = 0;
    const hit = el('rect', { class: 'hit', x: MARGIN.left, y: MARGIN.top, width: Math.max(1, pw), height: Math.max(1, ph) });
    hit.addEventListener('pointermove', (ev) => {
      const box = svg.getBoundingClientRect();
      const rel = ((ev.clientX - box.left) / box.width) * w - MARGIN.left;
      hoverIndex = Math.max(0, Math.min(n - 1, Math.round((rel / (pw || 1)) * (n - 1))));
      move(hoverIndex, ((ev.clientY - box.top) / box.height) * height - 14);
    });
    hit.addEventListener('pointerleave', () => {
      hideTooltip(tooltip); cross.setAttribute('visibility', 'hidden');
      focusDots.forEach((d) => d.setAttribute('visibility', 'hidden'));
    });
    svg.append(hit);

    svg.addEventListener('keydown', (ev) => {
      const jump = ev.shiftKey ? 7 : 1;
      if (ev.key === 'ArrowRight') hoverIndex = Math.min(n - 1, hoverIndex + jump);
      else if (ev.key === 'ArrowLeft') hoverIndex = Math.max(0, hoverIndex - jump);
      else if (ev.key === 'Home') hoverIndex = 0;
      else if (ev.key === 'End') hoverIndex = n - 1;
      else if (ev.key === 'Escape') { hideTooltip(tooltip); cross.setAttribute('visibility', 'hidden'); return; }
      else return;
      ev.preventDefault();
      move(hoverIndex, null);
    });
    svg.addEventListener('blur', () => hideTooltip(tooltip));

    return svg;
  });

  const columns = [
    ...cfg.series.map((s) => ({ name: s.name, values: s.values, format: (v) => (isNum(v) ? fmt(v) : '—') })),
    ...(cfg.band ? [
      { name: `${cfg.band.name} — low`, values: cfg.band.lo, format: (v) => (isNum(v) ? fmt(v) : '—') },
      { name: `${cfg.band.name} — high`, values: cfg.band.hi, format: (v) => (isNum(v) ? fmt(v) : '—') },
    ] : []),
  ];
  root.append(tableView(cfg.xHeader || 'Date', cfg.xLabels, columns));
  return root;
}

/* ---------- bar chart (with optional same-unit reference line) ---------- */

export function barChart(cfg) {
  const seriesForLegend = [{ ...cfg.bars, kind: 'rect' }, ...(cfg.overlay ? [cfg.overlay] : [])];
  const { root, figure, tooltip } = chartFrame({ ...cfg, series: seriesForLegend, band: null });
  const height = cfg.height || 240;
  const fmt = cfg.format || ((v) => (isNum(v) ? v.toFixed(1) : '—'));
  const n = cfg.xLabels.length;

  responsive(root, figure, (w) => {
    const pw = w - MARGIN.left - MARGIN.right;
    const ph = height - MARGIN.top - MARGIN.bottom;
    const pool = [...cfg.bars.values, ...(cfg.overlay ? cfg.overlay.values : []), 0].filter(isNum);
    const { ticks, lo, hi } = niceTicks(Math.min(...pool, 0), Math.max(...pool), 4);
    const band = pw / Math.max(1, n);
    const barW = Math.max(1, Math.min(24, band - 2));
    const X = (i) => MARGIN.left + band * i + band / 2;
    const Y = (v) => MARGIN.top + ph - ((v - lo) / (hi - lo || 1)) * ph;

    const svg = el('svg', {
      viewBox: `0 0 ${w} ${height}`, width: w, height, role: 'img', tabindex: '0',
      'aria-label': cfg.ariaLabel || `${cfg.title}. ${cfg.bars.name}. Use arrow keys to read values.`,
    });

    for (const t of ticks) {
      svg.append(el('line', { class: 'grid-line', x1: MARGIN.left, x2: MARGIN.left + pw, y1: Y(t), y2: Y(t) }));
      const label = el('text', { class: 'tick-text', x: MARGIN.left - 8, y: Y(t) + 4, 'text-anchor': 'end' });
      label.textContent = fmt(t);
      svg.append(label);
    }
    if (cfg.yLabel) {
      const yl = el('text', { class: 'axis-title', x: MARGIN.left - 8, y: MARGIN.top - 8, 'text-anchor': 'end' });
      yl.textContent = cfg.yLabel;
      svg.append(yl);
    }
    svg.append(el('line', { class: 'axis-line', x1: MARGIN.left, x2: MARGIN.left + pw, y1: Y(0), y2: Y(0) }));

    for (const i of spreadIndices(n, Math.max(2, Math.min(8, Math.floor(pw / 90))))) {
      const tick = el('text', { class: 'tick-text', x: X(i), y: height - 10, 'text-anchor': 'middle' });
      tick.textContent = cfg.xTickLabels ? cfg.xTickLabels[i] : cfg.xLabels[i];
      svg.append(tick);
    }

    const marks = [];
    for (let i = 0; i < n; i += 1) {
      const v = cfg.bars.values[i];
      if (!isNum(v)) { marks.push(null); continue; }
      const top = Math.min(Y(v), Y(0));
      const h = Math.abs(Y(v) - Y(0));
      const path = el('path', { class: 'mark-bar', d: barPath(X(i) - barW / 2, top, barW, h), fill: cfg.bars.color });
      svg.append(path);
      marks.push(path);
    }

    if (cfg.overlay) {
      let d = '';
      let open = false;
      for (let i = 0; i < n; i += 1) {
        if (isNum(cfg.overlay.values[i])) { d += `${open ? 'L' : 'M'}${X(i)},${Y(cfg.overlay.values[i])}`; open = true; } else open = false;
      }
      if (d) svg.append(el('path', { class: 'mark-line', d, stroke: cfg.overlay.color }));
    }

    const focus = (i, clientY) => {
      if (!Number.isInteger(i) || i < 0 || i >= n) return;
      marks.forEach((m, k) => m?.classList.toggle('dim', k !== i));
      const rows = [{ name: cfg.bars.name, color: cfg.bars.color, value: fmt(cfg.bars.values[i]) }];
      if (cfg.overlay) rows.push({ name: cfg.overlay.name, color: cfg.overlay.color, value: fmt(cfg.overlay.values[i]) });
      const yTop = isNum(cfg.bars.values[i]) ? Y(cfg.bars.values[i]) : MARGIN.top + ph;
      showTooltip(tooltip, { title: cfg.xLabels[i], rows }, X(i), clientY ?? yTop - 12, w);
    };
    const clear = () => { marks.forEach((m) => m?.classList.remove('dim')); hideTooltip(tooltip); };

    let cursor = 0;
    const hit = el('rect', { class: 'hit', x: MARGIN.left, y: MARGIN.top, width: Math.max(1, pw), height: Math.max(1, ph) });
    hit.addEventListener('pointermove', (ev) => {
      const box = svg.getBoundingClientRect();
      const rel = ((ev.clientX - box.left) / box.width) * w - MARGIN.left;
      cursor = Math.max(0, Math.min(n - 1, Math.floor(rel / band)));
      focus(cursor, ((ev.clientY - box.top) / box.height) * height - 14);
    });
    hit.addEventListener('pointerleave', clear);
    svg.append(hit);

    svg.addEventListener('keydown', (ev) => {
      const jump = ev.shiftKey ? 7 : 1;
      if (ev.key === 'ArrowRight') cursor = Math.min(n - 1, cursor + jump);
      else if (ev.key === 'ArrowLeft') cursor = Math.max(0, cursor - jump);
      else if (ev.key === 'Home') cursor = 0;
      else if (ev.key === 'End') cursor = n - 1;
      else if (ev.key === 'Escape') { clear(); return; }
      else return;
      ev.preventDefault();
      focus(cursor, null);
    });
    svg.addEventListener('blur', clear);

    return svg;
  });

  const columns = [
    { name: cfg.bars.name, values: cfg.bars.values, format: (v) => (isNum(v) ? fmt(v) : '—') },
    ...(cfg.overlay ? [{ name: cfg.overlay.name, values: cfg.overlay.values, format: (v) => (isNum(v) ? fmt(v) : '—') }] : []),
  ];
  root.append(tableView(cfg.xHeader || 'Date', cfg.xLabels, columns));
  return root;
}

/* Shared DOM helper — exported so the views build markup the same safe way
   (textContent only; API-supplied names are never interpolated into HTML). */
export { html as h };

