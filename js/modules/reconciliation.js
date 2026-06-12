// Reconciliation – best-in-class heatmap dashboard
import { el, fmtDate, drillDownModal } from '../core/ui.js';
import { availableYears, formatEUR, buildReconciliationData, listActivePayments, listActive, toEUR } from '../core/data.js';

export default {
  id: 'reconciliation',
  label: 'Reconciliation',
  icon: '⚖️',
  render(container) { container.appendChild(build()); },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); },
  destroy() {}
};

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const ENT_COLS = [
  { key: 'entity',      label: 'Entity' },
  { key: 'type',        label: 'Type' },
  { key: 'expected',    label: 'Expected',    right: true, format: v => formatEUR(v) },
  { key: 'received',    label: 'Received',    right: true, format: v => formatEUR(v) },
  { key: 'outstanding', label: 'Outstanding', right: true, format: v => formatEUR(v) }
];
const REC_COLS = [
  { key: 'date',   label: 'Date',   format: v => fmtDate(v) },
  { key: 'entity', label: 'Entity' },
  { key: 'ref',    label: 'Ref' },
  { key: 'status', label: 'Status' },
  { key: 'eur',    label: 'EUR', right: true, format: v => formatEUR(v) }
];

const payRow = (p, name) => ({ date: p.date,      entity: name, ref: p.confirmationCode || p.type || '', status: p.status, eur: toEUR(p.amount, p.currency, p.date) });
const invRow = (i, name) => ({ date: i.issueDate, entity: name, ref: i.number || '',                    status: i.status, eur: toEUR(i.total,  i.currency, i.issueDate) });
const byDate = rows => [...rows].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

function monthRange(mk) {
  const yr = Number(mk.slice(0, 4)), mo = Number(mk.slice(5, 7));
  return { start: `${mk}-01`, end: `${mk}-${new Date(yr, mo, 0).getDate().toString().padStart(2, '0')}` };
}

function cellStatus(m) {
  if (m.expected === 0 && m.actual === 0) return 'none';
  if (!m.isPast && m.expected > 0) return 'upcoming';
  if (!m.isPast) return 'bonus';
  if (m.expected === 0 && m.actual > 0) return 'bonus';
  if (m.actual >= m.expected) return 'reconciled';
  if (m.actual > 0) return 'partial';
  return 'missing';
}

const CELL_BG = {
  none:       'rgba(0,0,0,0.02)',
  upcoming:   'rgba(99,102,241,0.12)',
  reconciled: 'rgba(16,185,129,0.18)',
  partial:    'rgba(245,158,11,0.22)',
  missing:    'rgba(239,68,68,0.20)',
  bonus:      'rgba(16,185,129,0.18)',
};
const CELL_COLOR = {
  none:       '#94a3b8',
  upcoming:   '#6366f1',
  reconciled: '#059669',
  partial:    '#d97706',
  missing:    '#dc2626',
  bonus:      '#059669',
};

function cellLabel(m, st) {
  if (st === 'none')     return '';
  if (st === 'upcoming') return m.expected > 0 ? '↑' : '+';
  if (m.expected === 0)  return '+';
  return `${Math.round((m.actual / m.expected) * 100)}%`;
}

function rate(act, exp) {
  return exp > 0 ? Math.round((act / exp) * 100) : (act > 0 ? 100 : null);
}

// ── Drill-down openers ──────────────────────────────────────────────────────

function openCellModal(ent, m, yr) {
  const st = cellStatus(m);
  if (st === 'none') return;
  const title = `${ent.label} — ${MON[m.m - 1]} ${yr}`;

  if (ent.kind === 'lt') {
    const mk01 = `${m.mk}-01`;
    const tenants = listActive('tenants').filter(t => {
      if (t.propertyId !== ent.id || !t.monthlyRent) return false;
      const ls = t.leaseStartDate ? t.leaseStartDate.slice(0, 7) + '-01' : null;
      const le = t.leaseEndDate   ? t.leaseEndDate.slice(0, 7)   + '-01' : null;
      return (!ls || mk01 >= ls) && (!le || mk01 <= le);
    });
    if (tenants.length || st === 'upcoming' || st === 'missing') {
      return drillDownModal(title + (st === 'missing' ? ' — No Payment' : ' — Tenants'), tenants.map(t => ({
        tenant: t.name,
        lease:  `${t.leaseStartDate ? fmtDate(t.leaseStartDate) : '—'} → ${t.leaseEndDate ? fmtDate(t.leaseEndDate) : 'open-ended'}`,
        eur:    toEUR(t.monthlyRent, t.currency || 'EUR', Number(yr))
      })), [
        { key: 'tenant', label: 'Tenant' },
        { key: 'lease',  label: 'Lease Period' },
        { key: 'eur',    label: 'Monthly Rent', right: true, format: v => formatEUR(v) }
      ]);
    }
    // Fallthrough: show actual payments if we have them
    const { start, end } = monthRange(m.mk);
    const pays = listActivePayments().filter(p => p.propertyId === ent.id && p.date >= start && p.date <= end);
    return drillDownModal(title, byDate(pays.map(p => payRow(p, ent.label))), REC_COLS);
  }

  if (ent.kind === 'service') {
    const { start, end } = monthRange(m.mk);
    const invs = listActive('invoices').filter(i =>
      i.stream === ent.id && i.issueDate >= start && i.issueDate <= end && i.status !== 'draft'
    );
    return drillDownModal(title, byDate(invs.map(i => invRow(i, ent.label))), REC_COLS);
  }

  const { start, end } = monthRange(m.mk);
  const pays = listActivePayments().filter(p => p.propertyId === ent.id && p.date >= start && p.date <= end);
  drillDownModal(title, byDate(pays.map(p => payRow(p, ent.label))), REC_COLS);
}

function openEntityModal(ent, yr) {
  const title = `${ent.label} — ${yr}`;
  if (ent.kind === 'lt') {
    const yStart = `${yr}-01-01`, yEnd = `${yr}-12-31`;
    const tenants = listActive('tenants').filter(t => {
      if (t.propertyId !== ent.id || !t.monthlyRent) return false;
      const ls = t.leaseStartDate || '0000-01-01';
      const le = t.leaseEndDate   || '9999-12-31';
      return ls <= yEnd && le >= yStart;
    });
    if (tenants.length) {
      return drillDownModal(title + ' — Tenants', tenants.map(t => ({
        tenant: t.name,
        lease:  `${t.leaseStartDate ? fmtDate(t.leaseStartDate) : '—'} → ${t.leaseEndDate ? fmtDate(t.leaseEndDate) : 'open-ended'}`,
        eur:    toEUR(t.monthlyRent, t.currency || 'EUR', Number(yr))
      })), [
        { key: 'tenant', label: 'Tenant' },
        { key: 'lease',  label: 'Lease Period' },
        { key: 'eur',    label: 'Monthly Rent', right: true, format: v => formatEUR(v) }
      ]);
    }
  }
  if (ent.kind === 'service') {
    const invs = listActive('invoices').filter(i =>
      i.stream === ent.id && (i.issueDate || '').startsWith(yr) && i.status !== 'draft'
    );
    return drillDownModal(title, byDate(invs.map(i => invRow(i, ent.label))), REC_COLS);
  }
  const pays = listActivePayments().filter(p => p.propertyId === ent.id && (p.date || '').startsWith(yr));
  drillDownModal(title, byDate(pays.map(p => payRow(p, ent.label))), REC_COLS);
}

// ── Main build ──────────────────────────────────────────────────────────────

function build() {
  const wrap = el('div', { class: 'view active' });
  const curYear = String(new Date().getFullYear());
  // Only show years with actual data, capped at current year (future years have nothing to reconcile)
  const yearOpts = [...new Set([curYear, ...availableYears().filter(y => y <= curYear)])].sort().reverse();

  const yearSel = document.createElement('select');
  yearSel.className = 'form-control';
  yearSel.style.cssText = 'width:90px;font-size:13px';
  for (const y of yearOpts) {
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y;
    if (y === curYear) opt.selected = true;
    yearSel.appendChild(opt);
  }

  let kindFilter   = 'all';
  let statusFilter = 'all';

  function makeFilterGroup(items, getVal, setVal) {
    const grp = el('div', { style: 'display:inline-flex;border:1px solid var(--border);border-radius:6px;overflow:hidden' });
    const btns = [];
    const refresh = () => {
      btns.forEach((b, i) => {
        const active = items[i].key === getVal();
        b.style.background = active ? 'var(--primary)' : 'transparent';
        b.style.color      = active ? '#fff' : 'var(--text)';
      });
    };
    for (const item of items) {
      const b = el('button', {
        style: 'padding:5px 11px;font-size:12px;font-weight:500;border:none;cursor:pointer;border-right:1px solid var(--border);transition:background .15s'
      }, item.label);
      b.onclick = () => { setVal(item.key); refresh(); render(); };
      btns.push(b);
      grp.appendChild(b);
    }
    refresh();
    return grp;
  }

  const kindGrp = makeFilterGroup(
    [{ key: 'all', label: 'All' }, { key: 'lt', label: 'LT' }, { key: 'st', label: 'ST' }, { key: 'service', label: 'Services' }],
    () => kindFilter, v => kindFilter = v
  );
  const statusGrp = makeFilterGroup(
    [{ key: 'all', label: 'All' }, { key: 'problem', label: 'Problems' }, { key: 'reconciled', label: 'Reconciled' }],
    () => statusFilter, v => statusFilter = v
  );

  const sep = el('div', { style: 'width:1px;height:24px;background:var(--border)' });
  const controlBar = el('div', { class: 'flex gap-12 mb-16', style: 'align-items:center;flex-wrap:wrap' },
    el('div', { style: 'font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px' }, 'Year'),
    yearSel, sep,
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Type:'),   kindGrp,
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Status:'), statusGrp
  );
  wrap.appendChild(controlBar);

  const kpiRow     = el('div', { class: 'grid grid-4 mb-16' });
  const heatmapCard = el('div', { class: 'card mb-16' });
  const detailCard  = el('div', { class: 'card' });
  wrap.appendChild(kpiRow);
  wrap.appendChild(heatmapCard);
  wrap.appendChild(detailCard);

  const render = () => {
    kpiRow.innerHTML = '';
    heatmapCard.innerHTML = '';
    detailCard.innerHTML = '';

    const yr = yearSel.value;
    const allEntities = buildReconciliationData(Number(yr));
    const withData    = allEntities.filter(e => e.totExp > 0 || e.totAct > 0);

    const filtered = withData.filter(e => {
      if (kindFilter !== 'all' && e.kind !== kindFilter) return false;
      if (statusFilter === 'problem')    return e.months.some(m => { const s = cellStatus(m); return s === 'missing' || s === 'partial'; });
      if (statusFilter === 'reconciled') return e.months.every(m => { const s = cellStatus(m); return s !== 'missing' && s !== 'partial'; }) && (e.totAct > 0 || e.totExp > 0);
      return true;
    });

    // ── KPI cards (always reflect unfiltered totals) ────────────────────────
    const totExp     = withData.reduce((s, e) => s + e.totExp, 0);
    const totAct     = withData.reduce((s, e) => s + e.totAct, 0);
    const outstanding = withData.reduce((s, e) => s + Math.max(0, e.totExp - e.totAct), 0);
    const cr          = rate(totAct, totExp);

    const onExpected = () => drillDownModal(`Expected — ${yr}`,
      withData.filter(e => e.totExp > 0).map(e => ({
        entity: e.label,
        type: e.kind === 'lt' ? 'LT Rental' : e.kind === 'st' ? 'ST Rental' : 'Service',
        expected: e.totExp, received: e.totAct, outstanding: Math.max(0, e.totExp - e.totAct)
      })), ENT_COLS);

    const onReceived = () => {
      const propNames = new Map(withData.filter(e => e.kind !== 'service').map(e => [e.id, e.label]));
      const svcNames  = new Map(withData.filter(e => e.kind === 'service').map(e => [e.id, e.label]));
      const pays = listActivePayments().filter(p => p.status === 'paid' && (p.date || '').startsWith(yr) && propNames.has(p.propertyId));
      const invs = listActive('invoices').filter(i => i.status === 'paid' && (i.issueDate || '').startsWith(yr) && svcNames.has(i.stream));
      drillDownModal(`Received — ${yr}`, byDate([
        ...pays.map(p => payRow(p, propNames.get(p.propertyId) || '')),
        ...invs.map(i => invRow(i, svcNames.get(i.stream) || ''))
      ]), REC_COLS);
    };

    const onOutstanding = () => {
      const rows = withData.filter(e => e.totExp > e.totAct).map(e => ({
        entity: e.label,
        type: e.kind === 'lt' ? 'LT Rental' : e.kind === 'st' ? 'ST Rental' : 'Service',
        expected: e.totExp, received: e.totAct, outstanding: Math.max(0, e.totExp - e.totAct)
      }));
      drillDownModal(`Outstanding — ${yr}`, rows, ENT_COLS);
    };

    kpiRow.appendChild(kpi('Expected',       formatEUR(totExp),          '',                                                  onExpected));
    kpiRow.appendChild(kpi('Received',        formatEUR(totAct),          '',                                                  onReceived));
    kpiRow.appendChild(kpi('Outstanding',     formatEUR(outstanding),     outstanding > 0 ? 'danger' : 'success',              onOutstanding));
    kpiRow.appendChild(kpi('Collection Rate', cr !== null ? `${cr}%` : '—', cr === null ? '' : cr >= 100 ? 'success' : cr >= 75 ? 'warning' : 'danger', onOutstanding));

    // ── Heatmap ─────────────────────────────────────────────────────────────
    renderHeatmap(heatmapCard, filtered, yr);

    // ── Detail table ─────────────────────────────────────────────────────────
    renderDetail(detailCard, withData, yr);
  };

  // ── Heatmap renderer ──────────────────────────────────────────────────────
  function renderHeatmap(container, entities, yr) {
    const header = el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Collection Heatmap'),
      el('div', { style: 'font-size:11px;color:var(--text-muted)' }, 'Click any cell to view records • Click entity name to view full year')
    );
    container.appendChild(header);

    // Legend
    const legend = el('div', { style: 'display:flex;gap:14px;padding:8px 16px 10px;flex-wrap:wrap;border-bottom:1px solid var(--border)' });
    for (const [st, label] of [
      ['reconciled','Reconciled'],['partial','Partial'],['missing','Missing'],['upcoming','Upcoming'],['none','No expectation']
    ]) {
      const swatch = el('div', { style: `width:12px;height:12px;border-radius:3px;flex-shrink:0;background:${CELL_BG[st]};border:1px solid rgba(0,0,0,0.1)` });
      legend.appendChild(el('div', { style: 'display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text-muted)' }, swatch, label));
    }
    container.appendChild(legend);

    if (entities.length === 0) {
      container.appendChild(el('div', { class: 'empty', style: 'padding:48px 20px' }, 'No entities match the selected filters'));
      return;
    }

    const scroll = el('div', { style: 'overflow-x:auto' });
    container.appendChild(scroll);

    const t = document.createElement('table');
    t.style.cssText = 'width:100%;border-collapse:collapse;min-width:820px';

    // Colgroup
    const cg = document.createElement('colgroup');
    const addCol = w => { const c = document.createElement('col'); c.style.width = w; cg.appendChild(c); };
    addCol('180px');
    MON.forEach(() => addCol('52px'));
    addCol('62px');
    t.appendChild(cg);

    // Thead
    const thead = document.createElement('thead');
    const htr   = document.createElement('tr');
    htr.style.cssText = 'background:var(--surface)';
    const cellStyle = 'padding:7px 4px;font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.6px;border-bottom:2px solid var(--border);text-align:center';

    const th0 = document.createElement('th');
    th0.style.cssText = cellStyle + ';text-align:left;padding-left:12px;position:sticky;left:0;background:var(--surface)';
    th0.textContent = 'Entity';
    htr.appendChild(th0);

    for (const m of MON) {
      const th = document.createElement('th');
      th.style.cssText = cellStyle;
      th.textContent = m;
      htr.appendChild(th);
    }

    const thRate = document.createElement('th');
    thRate.style.cssText = cellStyle + ';padding-right:10px';
    thRate.textContent = 'Rate';
    htr.appendChild(thRate);
    thead.appendChild(htr);
    t.appendChild(thead);

    const tbody = document.createElement('tbody');
    const KINDS = [['lt','LT Rentals'],['st','ST Rentals'],['service','Services']];

    for (const [kind, kindLabel] of KINDS) {
      const gEnts = entities.filter(e => e.kind === kind);
      if (gEnts.length === 0) continue;

      // Section header
      const secTr = document.createElement('tr');
      const secTd = document.createElement('td');
      secTd.colSpan = 14;
      secTd.style.cssText = 'padding:9px 12px 5px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.8px;color:var(--text-muted);background:var(--surface);border-top:2px solid var(--border)';
      secTd.textContent = kindLabel;
      secTr.appendChild(secTd);
      tbody.appendChild(secTr);

      for (const ent of gEnts) {
        const tr = document.createElement('tr');
        tr.style.cssText = 'border-bottom:1px solid var(--border);transition:background .1s';
        tr.onmouseenter = () => tr.style.background = 'rgba(99,102,241,0.03)';
        tr.onmouseleave = () => tr.style.background = '';

        // Entity name cell (sticky)
        const nameTd = document.createElement('td');
        nameTd.style.cssText = 'padding:6px 12px;font-size:12px;font-weight:600;color:var(--text);cursor:pointer;position:sticky;left:0;background:var(--surface);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px;border-right:1px solid var(--border)';
        nameTd.title = ent.label;
        nameTd.textContent = ent.label;
        nameTd.onclick = () => openEntityModal(ent, yr);
        tr.appendChild(nameTd);

        // Month cells
        for (const m of ent.months) {
          const st  = cellStatus(m);
          const td  = document.createElement('td');
          const can = st !== 'none';
          td.style.cssText = `padding:5px 2px;text-align:center;background:${CELL_BG[st]};font-size:10px;font-weight:700;color:${CELL_COLOR[st]};cursor:${can ? 'pointer' : 'default'};border-right:1px solid var(--border);user-select:none;line-height:1`;
          td.textContent = cellLabel(m, st);
          td.title = `${MON[m.m-1]} — Expected: ${formatEUR(m.expected)} / Received: ${formatEUR(m.actual)}`;
          if (can) {
            td.onclick = () => openCellModal(ent, m, yr);
            td.onmouseenter = () => { td.style.outline = '2px solid var(--primary,#6366f1)'; td.style.outlineOffset = '-2px'; td.style.zIndex = '1'; td.style.position = 'relative'; };
            td.onmouseleave = () => { td.style.outline = ''; td.style.outlineOffset = ''; td.style.zIndex = ''; td.style.position = ''; };
          }
          tr.appendChild(td);
        }

        // Rate cell
        const r   = rate(ent.totAct, ent.totExp);
        const rtd = document.createElement('td');
        rtd.style.cssText = 'padding:5px 8px;text-align:center;font-size:11px;font-weight:700';
        if (r !== null) {
          rtd.style.color = r >= 100 ? '#059669' : r >= 75 ? '#d97706' : '#dc2626';
          rtd.textContent = `${r}%`;
        } else {
          rtd.textContent = '—';
          rtd.style.color = 'var(--text-muted)';
        }
        tr.appendChild(rtd);
        tbody.appendChild(tr);
      }

      // Section aggregate row
      const gExp  = gEnts.reduce((s, e) => s + e.totExp, 0);
      const gAct  = gEnts.reduce((s, e) => s + e.totAct, 0);
      const gRate = rate(gAct, gExp);
      const aggTr = document.createElement('tr');
      aggTr.style.cssText = 'background:var(--surface);border-top:1px solid var(--border)';

      const aggName = document.createElement('td');
      aggName.style.cssText = 'padding:6px 12px;font-size:11px;font-weight:700;color:var(--text-muted);position:sticky;left:0;background:var(--surface);border-right:1px solid var(--border)';
      aggName.textContent = kindLabel + ' Total';
      aggTr.appendChild(aggName);

      for (let mi = 0; mi < 12; mi++) {
        const mExp = gEnts.reduce((s, e) => s + (e.months[mi]?.expected || 0), 0);
        const mAct = gEnts.reduce((s, e) => s + (e.months[mi]?.actual   || 0), 0);
        const td   = document.createElement('td');
        td.style.cssText = 'padding:5px 2px;text-align:center;font-size:10px;font-weight:700;border-right:1px solid var(--border)';
        if (mExp > 0 || mAct > 0) {
          const r = rate(mAct, mExp);
          td.style.color = r === null ? '#059669' : r >= 100 ? '#059669' : r >= 75 ? '#d97706' : '#dc2626';
          td.textContent = r !== null ? `${r}%` : '+';
        }
        aggTr.appendChild(td);
      }

      const aggRate = document.createElement('td');
      aggRate.style.cssText = 'padding:5px 8px;text-align:center;font-size:11px;font-weight:700';
      if (gRate !== null) {
        aggRate.style.color = gRate >= 100 ? '#059669' : gRate >= 75 ? '#d97706' : '#dc2626';
        aggRate.textContent = `${gRate}%`;
      } else {
        aggRate.textContent = '—';
        aggRate.style.color = 'var(--text-muted)';
      }
      aggTr.appendChild(aggRate);
      tbody.appendChild(aggTr);
    }

    t.appendChild(tbody);
    scroll.appendChild(t);
  }

  // ── Detail table renderer ─────────────────────────────────────────────────
  function renderDetail(container, entities, yr) {
    container.appendChild(el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, `${yr} — Entity Summary`),
      el('div', { style: 'font-size:11px;color:var(--text-muted)' }, 'Click a row to view records')
    ));

    const t  = document.createElement('table');
    t.className = 'table';
    t.innerHTML = `<thead><tr>
      <th>Entity</th><th>Type</th>
      <th class="right">Expected</th><th class="right">Received</th>
      <th class="right">Outstanding</th><th class="right">Rate</th>
    </tr></thead>`;
    const tb = document.createElement('tbody');

    const groups = [['lt','LT Rental','long'],['st','ST Rental','short'],['service','Service','cs']];
    for (const [kind, kindLabel, badgeCls] of groups) {
      const gEnts = entities.filter(e => e.kind === kind && (e.totExp > 0 || e.totAct > 0));
      if (gEnts.length === 0) continue;

      for (const ent of gEnts) {
        const out = Math.max(0, ent.totExp - ent.totAct);
        const r   = rate(ent.totAct, ent.totExp);
        const tr  = document.createElement('tr');
        tr.style.cursor = 'pointer';
        if (out > 0) tr.style.background = out > ent.totExp * 0.25 ? 'rgba(239,68,68,.05)' : 'rgba(245,158,11,.06)';
        tr.onmouseenter = () => tr.style.opacity = '0.82';
        tr.onmouseleave = () => tr.style.opacity = '';
        tr.onclick = () => openEntityModal(ent, yr);
        tr.innerHTML = `
          <td style="font-weight:500">${ent.label}</td>
          <td><span class="badge ${badgeCls}">${kindLabel}</span></td>
          <td class="right num">${formatEUR(ent.totExp)}</td>
          <td class="right num">${formatEUR(ent.totAct)}</td>
          <td class="right num ${out > 0 ? 'danger' : 'success'}">${out > 0 ? formatEUR(out) : '—'}</td>
          <td class="right">${r !== null ? `<span class="badge ${r >= 100 ? 'success' : r >= 75 ? 'warning' : 'danger'}">${r}%</span>` : '<span class="muted">—</span>'}</td>
        `;
        tb.appendChild(tr);
      }

      // Kind subtotal
      const kExp  = gEnts.reduce((s, e) => s + e.totExp, 0);
      const kAct  = gEnts.reduce((s, e) => s + e.totAct, 0);
      const kOut  = Math.max(0, kExp - kAct);
      const kRate = rate(kAct, kExp);
      const subTr = document.createElement('tr');
      subTr.style.cssText = 'font-weight:600;border-top:1px solid var(--border);background:var(--surface)';
      subTr.innerHTML = `
        <td style="color:var(--text-muted);font-size:11px">${kindLabel} Subtotal</td>
        <td></td>
        <td class="right num">${formatEUR(kExp)}</td>
        <td class="right num">${formatEUR(kAct)}</td>
        <td class="right num ${kOut > 0 ? 'danger' : 'success'}">${kOut > 0 ? formatEUR(kOut) : '—'}</td>
        <td class="right">${kRate !== null ? `<span class="badge ${kRate >= 100 ? 'success' : kRate >= 75 ? 'warning' : 'danger'}">${kRate}%</span>` : '<span class="muted">—</span>'}</td>
      `;
      tb.appendChild(subTr);
    }

    // Grand total
    const gExp  = entities.reduce((s, e) => s + e.totExp, 0);
    const gAct  = entities.reduce((s, e) => s + e.totAct, 0);
    const gOut  = Math.max(0, gExp - gAct);
    const gRate = rate(gAct, gExp);
    const totTr = document.createElement('tr');
    totTr.style.cssText = 'font-weight:700;border-top:2px solid var(--border)';
    totTr.innerHTML = `
      <td>Grand Total</td><td></td>
      <td class="right num">${formatEUR(gExp)}</td>
      <td class="right num">${formatEUR(gAct)}</td>
      <td class="right num ${gOut > 0 ? 'danger' : 'success'}">${gOut > 0 ? formatEUR(gOut) : '—'}</td>
      <td class="right">${gRate !== null ? `<span class="badge ${gRate >= 100 ? 'success' : gRate >= 75 ? 'warning' : 'danger'}">${gRate}%</span>` : '<span class="muted">—</span>'}</td>
    `;
    tb.appendChild(totTr);
    t.appendChild(tb);
    container.appendChild(el('div', { class: 'table-wrap' }, t));
  }

  yearSel.onchange = render;
  render();
  return wrap;
}

function kpi(label, value, variant, onClick) {
  const d = el('div', { class: 'kpi' + (variant ? ' ' + variant : '') });
  if (onClick) { d.style.cursor = 'pointer'; d.onclick = onClick; }
  d.appendChild(el('div', { class: 'kpi-label' }, label));
  d.appendChild(el('div', { class: 'kpi-value' }, value));
  d.appendChild(el('div', { class: 'kpi-accent-bar' }));
  return d;
}
