// Chart.js wrappers
import { loadLib } from './libs.js';

const defaultColor = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#8b93b0';

const baseOpts = () => ({
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { labels: { color: '#e4e8f1', font: { size: 11 }, boxWidth: 12, padding: 12 } },
    tooltip: {
      backgroundColor: '#1e2235',
      borderColor: '#2a2f47',
      borderWidth: 1,
      titleColor: '#e4e8f1',
      bodyColor: '#e4e8f1',
      padding: 10,
      cornerRadius: 6
    }
  },
  scales: {
    x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#8b93b0', font: { size: 11 } } },
    y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#8b93b0', font: { size: 11 } } }
  }
});

const registry = new Map();

// ── Loading + staggered creation ─────────────────────────────────────────────
// Chart.js loads on demand (libs.js, pinned URL + SRI) instead of as a <script>
// every page load has to download before the app boots. The download starts
// as soon as this module is imported; line()/bar()/doughnut() stay synchronous
// for their callers — each call queues its chart, and a pump creates queued
// charts one per animation frame once Chart.js is in, so a view that draws
// ten charts at once doesn't block the main thread for all ten in one task.
// destroy()/destroyAll() cancel queued creations too. Only a failed load
// shows the "Chart unavailable" fallback.
let _chartLib = null;       // Promise<Chart|null> for the current load attempt
function chartLib() {
  if (typeof window.Chart !== 'undefined') return Promise.resolve(window.Chart);
  if (!_chartLib) {
    _chartLib = loadLib('chart').catch(err => {
      console.warn('[BT] Chart.js unavailable:', err?.message || err);
      _chartLib = null;     // the next chart request retries the download
      return null;
    });
  }
  return _chartLib;
}
try { if (document.head) chartLib(); } catch { /* no DOM (tests) */ }

const pending = new Map();  // id → queued creation { canvas, config }
const drawn = new Set();    // ids drawn at least once — re-renders skip the entry animation
let pumping = false;

function queueChart(id, canvas, config) {
  pending.set(id, { canvas, config });
  if (!pumping) pump();
}

async function pump() {
  pumping = true;
  try {
    while (pending.size) {
      const Chart = await chartLib();
      if (!Chart) {
        // Load failed: every chart still queued gets the fallback.
        for (const { canvas } of pending.values()) if (canvas.isConnected) showChartFallback(canvas);
        pending.clear();
        break;
      }
      await new Promise(r => requestAnimationFrame(() => r()));
      const next = pending.entries().next();
      if (next.done) break;
      const [id, job] = next.value;
      pending.delete(id);
      // The view moved on (navigated away / rebuilt its DOM) before our turn.
      if (!job.canvas.isConnected) continue;
      create(Chart, id, job);
    }
  } finally {
    pumping = false;
  }
}

function create(Chart, id, { canvas, config }) {
  clearChartFallback(canvas);
  if (drawn.has(id)) config.options.animation = false;
  try {
    const c = new Chart(canvas.getContext('2d'), config);
    registry.set(id, c);
    drawn.add(id);
  } catch (e) {
    console.error(e);
  }
}

function showChartFallback(canvas) {
  canvas.style.display = 'none';
  let fb = canvas.parentElement?.querySelector('.chart-cdn-fallback');
  if (!fb) {
    fb = document.createElement('p');
    fb.className = 'chart-cdn-fallback';
    fb.style.cssText = 'text-align:center;color:var(--text-muted);font-size:13px;padding:40px 16px;margin:0;font-style:italic';
    fb.textContent = 'Chart unavailable — network connection required to load Chart.js';
    canvas.parentElement.appendChild(fb);
  }
  fb.style.display = '';
}

function clearChartFallback(canvas) {
  canvas.style.display = '';
  const fb = canvas.parentElement?.querySelector('.chart-cdn-fallback');
  if (fb) fb.style.display = 'none';
}

// Charts whose canvas has left the document (a view rebuilt its DOM without
// destroying them first) — free them before creating another, so the
// registry and Chart.js's own instance list don't grow on every re-render.
function pruneDetached() {
  for (const [id, c] of registry) {
    if (!c.canvas || !c.canvas.isConnected) { try { c.destroy(); } catch { /* already gone */ } registry.delete(id); }
  }
  for (const [id, job] of pending) if (!job.canvas.isConnected) pending.delete(id);
}

export function destroy(id) {
  pending.delete(id);
  const c = registry.get(id);
  if (c) { c.destroy(); registry.delete(id); }
}

// Called on every navigation (router) — the next view's first draw of each
// chart animates again; re-renders within a view (destroy(id) + redraw) don't.
export function destroyAll() {
  pending.clear();
  drawn.clear();
  for (const [id, c] of registry) c.destroy();
  registry.clear();
}

// Default value formatter for bar labels/totals — whole euros, de-DE grouping.
// One shared formatter: toLocaleString() builds a new Intl.NumberFormat per
// call, and these labels are formatted for every bar/slice on every frame.
const DE_NUM = new Intl.NumberFormat('de-DE');
const fmtEURLabel = v => '€' + DE_NUM.format(Math.round(v));

export function line(id, { labels, datasets, onClickItem }) {
  destroy(id);
  pruneDetached();
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const opts = baseOpts();
  if (onClickItem) {
    opts.onClick = (_e, elements) => {
      if (!elements.length) return;
      const { datasetIndex, index } = elements[0];
      onClickItem(labels[index], index, datasetIndex);
    };
    canvas.style.cursor = 'pointer';
  }
  queueChart(id, canvas, {
    type: 'line',
    data: {
      labels,
      datasets: datasets.map(d => ({
        tension: 0.35,
        borderWidth: 2,
        pointRadius: 3,
        pointHoverRadius: 5,
        fill: true,
        ...d
      }))
    },
    options: opts
  });
}

// `formatValue` (optional) formats the drawn value labels and the showTotals
// footer/labels — defaults to whole euros; pass e.g. v => v.toFixed(0) + '%'
// for a percentage chart so it isn't mislabelled with "€".
export function bar(id, { labels, datasets, stacked = false, horizontal = false, onClickItem, showTotals = false, formatValue = fmtEURLabel }) {
  destroy(id);
  pruneDetached();
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const opts = baseOpts();
  if (stacked) { opts.scales.x.stacked = true; opts.scales.y.stacked = true; }
  if (horizontal) {
    opts.indexAxis = 'y';
    // The category axis becomes Y here. Chart.js's default autoSkip silently
    // drops tick labels once rows get too tight to fit them all — exactly
    // what happens once a dashboard has enough rows (properties, vendors...)
    // to outgrow the fixed .chart-wrap height, and it fails silent: a bar
    // renders with no name next to it, not an error. Never skip a category
    // label; the height grow below gives every row room instead.
    opts.scales.y.ticks.autoSkip = false;
    opts.scales.x.grace = '12%'; // headroom so the value labels drawn past each bar's tip aren't clipped
  } else {
    opts.scales.y.grace = '12%'; // headroom for the value labels drawn above/below each bar
  }
  if (onClickItem) {
    opts.onClick = (_e, elements) => {
      if (!elements.length) return;
      const { datasetIndex, index } = elements[0];
      onClickItem(labels[index], index, datasetIndex);
    };
    canvas.style.cursor = 'pointer';
  }

  // A fixed-height .chart-wrap looks fine for a handful of rows, but once a
  // horizontal bar chart has enough categories each row gets squeezed below
  // a legible height (the same squeeze that makes Chart.js autoSkip labels
  // above). Grow the wrapper — never shrink it — so every never-skipped
  // label has real room. Skipped when the wrapper isn't laid out yet
  // (offsetHeight 0, e.g. a hidden ancestor) rather than risk collapsing it.
  if (horizontal && canvas.parentElement) {
    const rowsNeeded = labels.length * 26 + 40;
    const current = canvas.parentElement.offsetHeight;
    if (current > 0 && rowsNeeded > current) canvas.parentElement.style.height = `${rowsNeeded}px`;
  }

  // Per-category total (sum of the stack at each index) — shown as a tooltip
  // footer and, for vertical charts, drawn above each bar.
  const localPlugins = [];
  if (showTotals) {
    const sumAt = (chart, i) => chart.data.datasets.reduce(
      (s, ds, di) => s + (chart.isDatasetVisible(di) ? (ds.data[i] || 0) : 0), 0);
    opts.plugins.tooltip.callbacks = {
      footer: items => items.length
        ? 'Total: ' + formatValue(sumAt(items[0].chart, items[0].dataIndex))
        : ''
    };
    if (!horizontal) {
      localPlugins.push({
        id: 'stackTotals',
        afterDatasetsDraw(chart) {
          const meta = chart.getDatasetMeta(0);
          if (!meta?.data) return;
          const g = chart.ctx;
          g.save();
          g.font = '600 11px sans-serif';
          g.fillStyle = '#e4e8f1';
          g.textAlign = 'center';
          g.textBaseline = 'bottom';
          meta.data.forEach((bar, i) => {
            const total = sumAt(chart, i);
            if (total <= 0) return;
            g.fillText(formatValue(total), bar.x, chart.scales.y.getPixelForValue(total) - 3);
          });
          g.restore();
        }
      });
    }
  }

  // Always-visible value labels — reading the amount currently means hovering
  // every bar one at a time. Stacked bars already get a total via showTotals
  // above; a label per segment there would just overlap, so this is
  // deliberately skipped for stacked charts.
  if (!stacked) localPlugins.push(valueLabelsPlugin(horizontal, formatValue));

  queueChart(id, canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: datasets.map(d => ({ borderRadius: 4, ...d }))
    },
    options: opts,
    plugins: localPlugins
  });
}

// Slice amount labels — drawn directly on each big-enough doughnut/pie wedge
// so the absolute value is legible at a glance instead of needing a hover per
// slice. The legend carries the percentage (see doughnut()'s generateLabels
// below) so amount and share are both always visible, never one-or-the-other
// behind a toggle.
function sliceLabelsPlugin() {
  return {
    id: 'sliceLabels',
    afterDatasetsDraw(chart) {
      const ds = chart.data.datasets[0];
      const meta = chart.getDatasetMeta(0);
      if (!meta?.data?.length) return;
      const visible = i => chart.getDataVisibility ? chart.getDataVisibility(i) : true;
      const total = ds.data.reduce((s, v, i) => s + (visible(i) && typeof v === 'number' ? v : 0), 0);
      if (total <= 0) return;
      const g = chart.ctx;
      g.save();
      g.font = '700 11px sans-serif';
      g.fillStyle = '#fff';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.shadowColor = 'rgba(0,0,0,0.55)';
      g.shadowBlur = 3;
      meta.data.forEach((arc, i) => {
        const val = ds.data[i];
        if (!visible(i) || !val) return;
        const pct = val / total * 100;
        if (pct < 4) return; // too thin a wedge to label legibly
        const angle = (arc.startAngle + arc.endAngle) / 2;
        const radius = (arc.innerRadius + arc.outerRadius) / 2;
        g.fillText(fmtEURLabel(val), arc.x + Math.cos(angle) * radius, arc.y + Math.sin(angle) * radius);
      });
      g.restore();
    }
  };
}

function valueLabelsPlugin(horizontal, formatValue = fmtEURLabel) {
  return {
    id: 'valueLabels',
    afterDatasetsDraw(chart) {
      const g = chart.ctx;
      g.save();
      g.font = '600 10px sans-serif';
      g.fillStyle = '#e4e8f1';
      chart.data.datasets.forEach((ds, di) => {
        if (!chart.isDatasetVisible(di)) return;
        const meta = chart.getDatasetMeta(di);
        meta.data.forEach((el, i) => {
          const raw = ds.data[i];
          if (raw === null || raw === undefined || raw === 0) return;
          const label = formatValue(raw);
          const positive = raw >= 0;
          if (horizontal) {
            g.textAlign = positive ? 'left' : 'right';
            g.textBaseline = 'middle';
            g.fillText(label, el.x + (positive ? 6 : -6), el.y);
          } else {
            g.textAlign = 'center';
            g.textBaseline = positive ? 'bottom' : 'top';
            g.fillText(label, el.x, el.y + (positive ? -4 : 4));
          }
        });
      });
      g.restore();
    }
  };
}

// Legend entries always carry each slice's percentage of the total — paired
// with sliceLabelsPlugin's on-slice € amount, so amount and share are both
// always visible without a hover or a toggle.
function legendLabelsWithPct(chart) {
  const ds = chart.data.datasets[0];
  // Match sliceLabelsPlugin: when a slice has been hidden via legend-click
  // (Chart.js's default toggle), the remaining slices' percentages must be
  // computed against the still-visible total, not the original whole-pie
  // total, or every visible slice's % understates its actual visible share.
  const visible = i => chart.getDataVisibility ? chart.getDataVisibility(i) : true;
  const total = ds.data.reduce((s, v, i) => s + (visible(i) && typeof v === 'number' ? v : 0), 0);
  return chart.data.labels.map((lbl, i) => ({
    text: lbl + (total > 0 && visible(i) ? ` (${(ds.data[i] / total * 100).toFixed(1)}%)` : ''),
    fillStyle: ds.backgroundColor[i],
    strokeStyle: '#161a27',
    lineWidth: 2,
    // Reflect the slice's real visibility so a legend-click-hidden slice
    // renders struck through instead of looking still active.
    hidden: !visible(i),
    index: i,
    fontColor: '#e4e8f1'
  }));
}

export function doughnut(id, { labels, data, colors, onClickItem }) {
  destroy(id);
  pruneDetached();
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const opts = baseOpts();
  delete opts.scales;
  opts.cutout = '65%';
  opts.plugins.legend.position = 'right';
  opts.plugins.legend.labels.generateLabels = legendLabelsWithPct;
  if (onClickItem) {
    opts.onClick = (_e, elements) => {
      if (!elements.length) return;
      const { index } = elements[0];
      onClickItem(labels[index], index, 0);
    };
    canvas.style.cursor = 'pointer';
  }
  queueChart(id, canvas, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors,
        borderColor: '#161a27',
        borderWidth: 2
      }]
    },
    options: opts,
    plugins: [sliceLabelsPlugin()]
  });
}
