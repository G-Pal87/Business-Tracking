// Insights — derived layer: owner-split, YTD vs LY, cross-entity summary
// Stream P&L detail lives in Reports > By Stream to avoid duplication
import { state } from '../core/state.js';
import { el, select } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS, OWNERS } from '../core/config.js';
import { toEUR, formatEUR, byId, availableYears, revenueInRangeEUR, expensesInRangeEUR, ytdRange } from '../core/data.js';

export default {
  id: 'insights',
  label: 'Insights',
  icon: 'S',
  render(container) { container.appendChild(build()); },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); },
  destroy() { charts.destroyAll(); }
};

function build() {
  const wrap = el('div', { class: 'view active' });
  const { start: ytdStart, end: ytdEnd } = ytdRange();
  const now = new Date();
  const lyEnd = new Date(now); lyEnd.setFullYear(now.getFullYear() - 1);
  const lyStart = `${now.getFullYear() - 1}-01-01`;

  const revYTD = revenueInRangeEUR(ytdStart, ytdEnd);
  const expYTD = expensesInRangeEUR(ytdStart, ytdEnd, {}, { includeRenovation: false });
  const revLY  = revenueInRangeEUR(lyStart, lyEnd.toISOString().slice(0, 10));
  const expLY  = expensesInRangeEUR(lyStart, lyEnd.toISOString().slice(0, 10), {}, { includeRenovation: false });
  const netYTD = revYTD - expYTD;
  const netLY  = revLY - expLY;

  const yoyRev = revLY  ? ((revYTD - revLY)  / revLY  * 100) : 0;
  const yoyNet = netLY  ? ((netYTD - netLY)  / netLY  * 100) : 0;

  // YTD vs LY KPIs
  wrap.appendChild(el('div', { class: 'grid grid-4 mb-16' },
    kpiYoY('Revenue YTD', formatEUR(revYTD), yoyRev),
    kpiYoY('Expenses YTD', formatEUR(expYTD), -(expYTD - expLY) / (expLY || 1) * 100),
    kpiYoY('Net YTD', formatEUR(netYTD), yoyNet),
    kpi('Last Year Net', formatEUR(netLY), 'full year')
  ));

  // Owner split chart + monthly YTD comparison chart
  wrap.appendChild(el('div', { class: 'grid grid-2 mt-16' },
    el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue by Owner (YTD)')),
      el('div', { class: 'chart-wrap' }, el('canvas', { id: 'ins-owner' }))
    ),
    el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'YTD vs Same Period Last Year (monthly)')),
      el('div', { class: 'chart-wrap' }, el('canvas', { id: 'ins-yoy' }))
    )
  ));

  // Owner table
  const ownerRows = buildOwnerRows(ytdStart, ytdEnd);
  const ownerTable = el('table', { class: 'table' });
  ownerTable.innerHTML = `<thead><tr><th>Owner</th><th class="right">Revenue</th><th class="right">Expenses</th><th class="right">Net</th></tr></thead>`;
  const tb = el('tbody');
  for (const r of ownerRows) {
    const tr = el('tr');
    tr.appendChild(el('td', {}, el('span', { class: 'badge' }, OWNERS[r.owner] || r.owner)));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(r.rev)));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(r.exp)));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(r.net)));
    tb.appendChild(tr);
  }
  ownerTable.appendChild(tb);
  const tw = el('div', { class: 'table-wrap mt-16' }); tw.appendChild(ownerTable);
  wrap.appendChild(el('div', { class: 'card mt-16' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Performance by Owner'), el('a', { href: '#reports', style: 'font-size:12px;color:var(--accent)' }, 'Full stream detail in Reports')),
    tw
  ));

  // Charts
  setTimeout(() => {
    const ownerData = ownerRows.map(r => Math.round(r.rev));
    const ownerLabels = ownerRows.map(r => OWNERS[r.owner] || r.owner);
    charts.doughnut('ins-owner', { labels: ownerLabels, data: ownerData, colors: ['#6366f1', '#ec4899', '#14b8a6'] });

    // YoY monthly comparison: last 12 months (this year) vs same 12 months last year
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(d.toISOString().slice(0, 7));
    }
    const lyMonths = months.map(m => {
      const [y, mo] = m.split('-');
      return `${Number(y) - 1}-${mo}`;
    });
    const thisRevs = months.map(m => {
      const s = m + '-01', e = m + '-' + new Date(Number(m.slice(0,4)), Number(m.slice(5,7)), 0).getDate().toString().padStart(2,'0');
      return Math.round(revenueInRangeEUR(s, e));
    });
    const lastRevs = lyMonths.map(m => {
      const s = m + '-01', e = m + '-' + new Date(Number(m.slice(0,4)), Number(m.slice(5,7)), 0).getDate().toString().padStart(2,'0');
      return Math.round(revenueInRangeEUR(s, e));
    });
    charts.bar('ins-yoy', {
      labels: months.map(m => { const [y,mo] = m.split('-'); return new Date(Number(y),Number(mo)-1,1).toLocaleDateString('en-US',{month:'short'}); }),
      datasets: [
        { label: 'This year', data: thisRevs, backgroundColor: '#6366f1' },
        { label: 'Last year', data: lastRevs, backgroundColor: 'rgba(99,102,241,0.3)' }
      ]
    });
  }, 0);

  return wrap;
}

function buildOwnerRows(start, end) {
  const ownerKeys = ['you', 'rita', 'both'];
  return ownerKeys.map(owner => {
    const pays = (state.db.payments || []).filter(p => {
      const prop = byId('properties', p.propertyId);
      return p.status === 'paid' && p.date >= start && p.date <= end && prop?.owner === owner;
    });
    const invs = (state.db.invoices || []).filter(i => i.status === 'paid' && i.issueDate >= start && i.issueDate <= end && i.owner === owner);
    const exps = (state.db.expenses || []).filter(e => e.category !== 'renovation' && e.date >= start && e.date <= end && (byId('properties', e.propertyId)?.owner === owner));
    const rev = [...pays.map(p => toEUR(p.amount, p.currency)), ...invs.map(i => toEUR(i.total, i.currency))].reduce((a, b) => a + b, 0);
    const exp = exps.reduce((s, e) => s + toEUR(e.amount, e.currency), 0);
    return { owner, rev, exp, net: rev - exp };
  }).filter(r => r.rev > 0 || r.exp > 0);
}

function kpi(label, value, sub) {
  return el('div', { class: 'kpi' },
    el('div', { class: 'kpi-label' }, label),
    el('div', { class: 'kpi-value' }, value),
    el('div', { class: 'kpi-trend' }, sub || ''),
    el('div', { class: 'kpi-accent-bar' })
  );
}

function kpiYoY(label, value, pct) {
  const cls = pct > 0 ? 'success' : pct < 0 ? 'danger' : '';
  const sign = pct > 0 ? '+' : '';
  return el('div', { class: 'kpi' },
    el('div', { class: 'kpi-label' }, label),
    el('div', { class: 'kpi-value' }, value),
    el('div', { class: 'kpi-trend' }, el('span', { class: cls }, `${sign}${pct.toFixed(1)}% vs LY`)),
    el('div', { class: 'kpi-accent-bar' })
  );
}
