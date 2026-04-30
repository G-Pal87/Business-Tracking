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

export function bar(id, { labels, datasets, stacked = false, horizontal = false, onClickItem }) {
  destroy(id);
  const canvas = document.getElementById(id);
  if (!canvas) return;
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
  const c = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: datasets.map(d => ({ borderRadius: 4, ...d }))
    },
    options: opts
  });
  registry.set(id, c);
}

export function doughnut(id, { labels, data, colors, onClickItem }) {
  destroy(id);
  const canvas = document.getElementById(id);
  if (!canvas) return;
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
