// Dashboard module
import { state } from '../core/state.js';
import { el, escapeHtml, fmtDate, monthLabel } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS } from '../core/config.js';
import {
  totalRevenueEUR, totalExpensesEUR, renovationCapexEUR, netIncomeEUR,
  revenueInRangeEUR, expensesInRangeEUR, ytdRange,
  groupByMonth, groupByStream, recentActivity, formatEUR, byId
} from '../core/data.js';

export default {
  id: 'dashboard',
  label: 'Dashboard',
  icon: 'D',

  render(container) {
    container.appendChild(this.build());
    this.renderCharts();
  },

  refresh() {
    const c = document.getElementById('content');
    c.innerHTML = '';
    c.appendChild(this.build());
    this.renderCharts();
  },

  destroy() {
    charts.destroyAll();
  },

  build() {
    const wrap = el('div', { class: 'view active' });
    const { start, end } = ytdRange();
    const now = new Date();

    const lastYearStart = `${now.getFullYear() - 1}-01-01`;
    const lastYearSame = new Date(now); lastYearSame.setFullYear(now.getFullYear() - 1);
    const lastYearEnd = lastYearSame.toISOString().slice(0, 10);

    const revYTD = revenueInRangeEUR(start, end);
    const expYTD = expensesInRangeEUR(start, end, {}, { includeRenovation: false });
    const renoYTD = expensesInRangeEUR(start, end) - expYTD;
    const netYTD = revYTD - expYTD;

    const revLY = revenueInRangeEUR(lastYearStart, lastYearEnd);
    const expLY = expensesInRangeEUR(lastYearStart, lastYearEnd, {}, { includeRenovation: false });

    const revDelta = revLY ? ((revYTD - revLY) / revLY) * 100 : 0;
    const expDelta = expLY ? ((expYTD - expLY) / expLY) * 100 : 0;

    const totalProperties = (state.db.properties || []).length;
    const active = (state.db.properties || []).filter(p => p.status === 'active').length;
    const reno = (state.db.properties || []).filter(p => p.status === 'renovation').length;
    const openInv = (state.db.invoices || []).filter(i => i.status === 'sent' || i.status === 'overdue').length;
    const outstanding = (state.db.invoices || [])
      .filter(i => i.status !== 'paid' && i.status !== 'draft')
      .reduce((s, i) => s + (i.currency === 'HUF' ? i.total * (state.db.settings?.fxRates?.HUF_EUR || 0.0025) : i.total), 0);

    // KPI grid
    const kpis = el('div', { class: 'grid grid-4' },
      kpi('Revenue YTD', formatEUR(revYTD), revLY ? trendText(revDelta) : 'No prior data'),
      kpi('Expenses YTD', formatEUR(expYTD), revLY ? trendText(-expDelta) : 'No prior data'),
      kpi('Net YTD', formatEUR(netYTD), `Margin ${revYTD ? ((netYTD / revYTD) * 100).toFixed(0) : 0}%`, netYTD >= 0 ? 'success' : 'danger'),
      kpi('Renovation CapEx YTD', formatEUR(renoYTD), `${reno} property in renovation`, 'warning')
    );

    const kpis2 = el('div', { class: 'grid grid-4 mt-16' },
      kpi('Properties', String(totalProperties), `${active} active, ${reno} renovation`),
      kpi('Active Invoices', String(openInv), `Outstanding ${formatEUR(outstanding)}`),
      kpi('Clients', String((state.db.clients || []).length), 'Across both streams'),
      kpi('Total Portfolio', formatEUR(portfolioValueEUR()), 'At purchase + CapEx')
    );

    wrap.appendChild(kpis);
    wrap.appendChild(kpis2);

    // Charts row
    const row = el('div', { class: 'grid grid-2 mt-24' });
    row.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('div', {}, el('div', { class: 'card-title' }, 'Revenue vs Expenses (last 12 months)'))),
      el('div', { class: 'chart-wrap' }, el('canvas', { id: 'chart-rev-exp' }))
    ));
    row.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('div', {}, el('div', { class: 'card-title' }, 'Revenue by Business Stream'))),
      el('div', { class: 'chart-wrap' }, el('canvas', { id: 'chart-stream' }))
    ));
    wrap.appendChild(row);

    // Recent activity + property quick list
    const row2 = el('div', { class: 'grid grid-2 mt-24' });
    row2.appendChild(buildActivityCard());
    row2.appendChild(buildTopPropertiesCard());
    wrap.appendChild(row2);

    return wrap;
  },

  renderCharts() {
    // Last 12 months revenue/expenses
    const now = new Date();
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(d.toISOString().slice(0, 7));
    }

    const paidPayments = (state.db.payments || []).filter(p => p.status === 'paid');
    const paidInvoices = (state.db.invoices || []).filter(i => i.status === 'paid').map(i => ({ ...i, date: i.issueDate, amount: i.total }));
    const revByMonth = groupByMonth([...paidPayments, ...paidInvoices]);
    const opExpenses = (state.db.expenses || []).filter(e => e.category !== 'renovation');
    const renoExpenses = (state.db.expenses || []).filter(e => e.category === 'renovation');
    const expByMonth = groupByMonth(opExpenses);
    const renoByMonth = groupByMonth(renoExpenses);

    const labels = months.map(monthLabel);
    charts.bar('chart-rev-exp', {
      labels,
      datasets: [
        { label: 'Revenue', data: months.map(m => Math.round(revByMonth.get(m) || 0)), backgroundColor: '#10b981' },
        { label: 'Operating', data: months.map(m => Math.round(expByMonth.get(m) || 0)), backgroundColor: '#ef4444' },
        { label: 'Renovation', data: months.map(m => Math.round(renoByMonth.get(m) || 0)), backgroundColor: '#f59e0b' }
      ]
    });

    // Revenue by stream YTD
    const { start, end } = ytdRange();
    const streamPayments = (state.db.payments || []).filter(p => p.status === 'paid' && p.date >= start && p.date <= end);
    const streamInvoices = (state.db.invoices || []).filter(i => i.status === 'paid' && i.issueDate >= start && i.issueDate <= end).map(i => ({ ...i, amount: i.total }));
    const byStream = groupByStream([...streamPayments, ...streamInvoices]);
    const labels2 = [];
    const data2 = [];
    const colors2 = [];
    for (const [key, meta] of Object.entries(STREAMS)) {
      labels2.push(meta.short);
      data2.push(Math.round(byStream.get(key) || 0));
      colors2.push(meta.color);
    }
    charts.doughnut('chart-stream', { labels: labels2, data: data2, colors: colors2 });
  }
};

function kpi(label, value, sub, variant) {
  return el('div', { class: 'kpi' + (variant ? ' ' + variant : '') },
    el('div', { class: 'kpi-label' }, label),
    el('div', { class: 'kpi-value' }, value),
    el('div', { class: 'kpi-trend' }, sub || ''),
    el('div', { class: 'kpi-accent-bar' })
  );
}

function trendText(pct) {
  const sign = pct > 0 ? '+' : '';
  const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : '';
  return el('span', { class: cls }, `${sign}${pct.toFixed(1)}% vs last yr`);
}

function portfolioValueEUR() {
  const fx = state.db.settings?.fxRates?.HUF_EUR || 0.0025;
  let total = 0;
  for (const p of state.db.properties || []) {
    const base = p.currency === 'HUF' ? (p.purchasePrice || 0) * fx : (p.purchasePrice || 0);
    total += base;
  }
  const renoFX = (state.db.expenses || []).filter(e => e.category === 'renovation').reduce((s, e) => s + (e.currency === 'HUF' ? e.amount * fx : e.amount), 0);
  return total + renoFX;
}

function buildActivityCard() {
  const items = recentActivity(8);
  const list = el('div', { class: 'activity-list' });
  if (items.length === 0) list.appendChild(el('div', { class: 'empty' }, 'No activity yet'));
  for (const it of items) {
    let icon = 'P', label = '', sub = '', amountText = '', amountCls = '';
    if (it.kind === 'payment') {
      const prop = byId('properties', it.data.propertyId);
      icon = '+'; label = prop?.name || 'Property';
      sub = `${fmtDate(it.date)} . payment received`;
      amountText = `+${new Intl.NumberFormat('en-US', { style: 'currency', currency: it.data.currency, maximumFractionDigits: 0 }).format(it.data.amount)}`;
      amountCls = 'success';
    } else if (it.kind === 'expense') {
      const prop = byId('properties', it.data.propertyId);
      icon = '-'; label = `${prop?.name || ''} . ${it.data.description || it.data.category}`;
      sub = `${fmtDate(it.date)} . ${it.data.category}`;
      amountText = `-${new Intl.NumberFormat('en-US', { style: 'currency', currency: it.data.currency, maximumFractionDigits: 0 }).format(it.data.amount)}`;
      amountCls = 'danger';
    } else if (it.kind === 'invoice') {
      const client = byId('clients', it.data.clientId);
      icon = 'I'; label = `Invoice ${it.data.number}`;
      sub = `${fmtDate(it.date)} . ${client?.name || ''}`;
      amountText = new Intl.NumberFormat('en-US', { style: 'currency', currency: it.data.currency, maximumFractionDigits: 0 }).format(it.data.total);
      amountCls = it.data.status === 'paid' ? 'success' : '';
    }
    list.appendChild(el('div', { class: 'activity-item' },
      el('div', { class: 'left' },
        el('div', { class: 'icon' }, icon),
        el('div', {},
          el('div', {}, label),
          el('div', { class: 'activity-meta' }, sub)
        )
      ),
      el('div', { class: amountCls }, amountText)
    ));
  }
  return el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Recent Activity')),
    list
  );
}

function buildTopPropertiesCard() {
  const now = new Date().getFullYear();
  const props = (state.db.properties || []).map(p => {
    const rev = (state.db.payments || [])
      .filter(pay => pay.propertyId === p.id && pay.status === 'paid' && (pay.date || '').startsWith(String(now)))
      .reduce((s, pay) => s + (pay.currency === 'HUF' ? pay.amount * (state.db.settings?.fxRates?.HUF_EUR || 0.0025) : pay.amount), 0);
    return { p, rev };
  }).sort((a, b) => b.rev - a.rev).slice(0, 5);

  const list = el('div', { class: 'activity-list' });
  if (props.length === 0) list.appendChild(el('div', { class: 'empty' }, 'No properties'));
  for (const { p, rev } of props) {
    list.appendChild(el('div', { class: 'activity-item' },
      el('div', { class: 'left' },
        el('div', { class: 'icon' }, p.flag || 'P'),
        el('div', {},
          el('div', {}, p.name),
          el('div', { class: 'activity-meta' }, `${p.city}, ${p.country} . ${p.status}`)
        )
      ),
      el('div', { class: 'num' }, formatEUR(rev))
    ));
  }
  return el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Top Properties YTD')),
    list
  );
}
