// Chart.js wrappers
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

export function destroy(id) {
  const c = registry.get(id);
  if (c) { c.destroy(); registry.delete(id); }
}

export function destroyAll() {
  for (const [id, c] of registry) c.destroy();
  registry.clear();
}

export function line(id, { labels, datasets, onClickItem }) {
  destroy(id);
  const canvas = document.getElementById(id);
  if (!canvas) return;
  if (typeof window.Chart === 'undefined') { showChartFallback(canvas); return; }
  clearChartFallback(canvas);
  const ctx = canvas.getContext('2d');
  const opts = baseOpts();
  if (onClickItem) {
    opts.onClick = (_e, elements) => {
      if (!elements.length) return;
      const { datasetIndex, index } = elements[0];
      onClickItem(labels[index], index, datasetIndex);
    };
    canvas.style.cursor = 'pointer';
  }
  const c = new Chart(ctx, {
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
  registry.set(id, c);
}

export function bar(id, { labels, datasets, stacked = false, horizontal = false, onClickItem, showTotals = false }) {
  destroy(id);
  const canvas = document.getElementById(id);
  if (!canvas) return;
  if (typeof window.Chart === 'undefined') { showChartFallback(canvas); return; }
  clearChartFallback(canvas);
  const ctx = canvas.getContext('2d');
  const opts = baseOpts();
  if (stacked) { opts.scales.x.stacked = true; opts.scales.y.stacked = true; }
  if (horizontal) opts.indexAxis = 'y';
  if (onClickItem) {
    opts.onClick = (_e, elements) => {
      if (!elements.length) return;
      const { datasetIndex, index } = elements[0];
      onClickItem(labels[index], index, datasetIndex);
    };
    canvas.style.cursor = 'pointer';
  }

  // Per-category total (sum of the stack at each index) — shown as a tooltip
  // footer and, for vertical charts, drawn above each bar.
  const localPlugins = [];
  if (showTotals) {
    const sumAt = (chart, i) => chart.data.datasets.reduce(
      (s, ds, di) => s + (chart.isDatasetVisible(di) ? (ds.data[i] || 0) : 0), 0);
    opts.plugins.tooltip.callbacks = {
      footer: items => items.length
        ? 'Total: €' + Math.round(sumAt(items[0].chart, items[0].dataIndex)).toLocaleString('de-DE')
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
            g.fillText('€' + Math.round(total).toLocaleString('de-DE'), bar.x, chart.scales.y.getPixelForValue(total) - 3);
          });
          g.restore();
        }
      });
    }
  }

  const c = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: datasets.map(d => ({ borderRadius: 4, ...d }))
    },
    options: opts,
    plugins: localPlugins
  });
  registry.set(id, c);
}

export function toggleDoughnutPct(id) {
  const c = registry.get(id);
  if (!c) return false;
  c._showPct = !c._showPct;
  const sp = c._showPct;
  c.options.plugins.tooltip.callbacks = {
    label: ctx => {
      const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
      return sp
        ? ` ${total > 0 ? (ctx.parsed / total * 100).toFixed(1) : 0}%`
        : ` €${Math.round(ctx.parsed).toLocaleString('de-DE')}`;
    }
  };
  c.options.plugins.legend.labels.generateLabels = chart => {
    const ds = chart.data.datasets[0];
    const total = ds.data.reduce((a, b) => a + b, 0);
    return chart.data.labels.map((lbl, i) => ({
      text: lbl + (sp ? ` (${total > 0 ? (ds.data[i] / total * 100).toFixed(1) : 0}%)` : ''),
      fillStyle: ds.backgroundColor[i],
      strokeStyle: '#161a27',
      lineWidth: 2,
      hidden: false,
      index: i,
      fontColor: '#e4e8f1'
    }));
  };
  c.update();
  return sp;
}

export function doughnut(id, { labels, data, colors, onClickItem }) {
  destroy(id);
  const canvas = document.getElementById(id);
  if (!canvas) return;
  if (typeof window.Chart === 'undefined') { showChartFallback(canvas); return; }
  clearChartFallback(canvas);
  const ctx = canvas.getContext('2d');
  const opts = baseOpts();
  delete opts.scales;
  opts.cutout = '65%';
  opts.plugins.legend.position = 'right';
  if (onClickItem) {
    opts.onClick = (_e, elements) => {
      if (!elements.length) return;
      const { index } = elements[0];
      onClickItem(labels[index], index, 0);
    };
    canvas.style.cursor = 'pointer';
  }
  const c = new Chart(ctx, {
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
    options: opts
  });
  registry.set(id, c);
}
