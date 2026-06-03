// STR Performance Dashboard — portfolio summary, property spotlight, forward pipeline
import { el, openModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { state } from '../core/state.js';
import { formatEUR, listActive, listActivePayments, byId } from '../core/data.js';
import {
  mkKpiCard, mkSummaryGrid, mkSummaryBox, mkModalTable, mkSectionLabel,
  mkEmptyState, mkVarianceBadge, mkProgressBar, fmtK, safePct
} from './analytics-helpers.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const CHART_IDS = ['str-rev-trend', 'str-occ-bar', 'str-adr-line', 'str-prop-rev-donut', 'str-spotlight-adr', 'str-spotlight-occ'];
const ML = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const PROP_COLORS = ['#6366f1','#14b8a6','#f59e0b','#ec4899','#22c55e'];

// ── State ─────────────────────────────────────────────────────────────────────
let gYear = String(new Date().getFullYear());
let gSpotlightPropId = null;

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id: 'analytics-str',
  label: 'STR Performance',
  icon: '⌂',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── Data helpers ──────────────────────────────────────────────────────────────
function getStrProps() {
  return listActive('properties').filter(p => p.type === 'short_term');
}

function getPaymentsForYear(year) {
  const prefix = year + '-';
  return listActivePayments().filter(p =>
    p.stream === 'short_term_rental' &&
    p.status === 'paid' &&
    (p.date || '').startsWith(prefix)
  );
}

function getTargetADR(propertyId, monthKey) {
  const targets = state.db.strRateTargets || [];
  return targets.find(t => t.propertyId === propertyId && t.month === monthKey) || null;
}

function getCalendar(propertyId) {
  return (state.db.strCalendars || []).find(c => c.propertyId === propertyId) || null;
}

// Count nights blocked (booked/reserved) in a given month from iCal blocks
function countBlockedNights(blocks, year, monthIdx) {
  if (!blocks?.length) return 0;
  const monthStart = new Date(year, monthIdx, 1);
  const monthEnd   = new Date(year, monthIdx + 1, 1);
  let nights = 0;
  for (const b of blocks) {
    if (!b.start || !b.end) continue;
    const bs = new Date(b.start);
    const be = new Date(b.end);
    const overlapStart = bs > monthStart ? bs : monthStart;
    const overlapEnd   = be < monthEnd   ? be : monthEnd;
    if (overlapEnd > overlapStart) {
      nights += Math.round((overlapEnd - overlapStart) / 86400000);
    }
  }
  return nights;
}

function daysInMonth(year, monthIdx) {
  return new Date(year, monthIdx + 1, 0).getDate();
}

// ── Portfolio-level data ──────────────────────────────────────────────────────
function getPortfolioData(year) {
  const yr = parseInt(year, 10);
  const payments = getPaymentsForYear(year);
  const props    = getStrProps();

  // Revenue per property
  const revByProp = new Map();
  props.forEach(p => revByProp.set(p.id, 0));
  payments.forEach(p => {
    if (p.propertyId) revByProp.set(p.propertyId, (revByProp.get(p.propertyId) || 0) + p.amount);
  });
  const totalRev = [...revByProp.values()].reduce((s, v) => s + v, 0);

  // Revenue by month (for trend chart)
  const revByMonth = Array.from({ length: 12 }, () => ({}));
  payments.forEach(p => {
    const mo = parseInt((p.date || '').slice(5, 7), 10) - 1;
    if (mo >= 0 && mo < 12 && p.propertyId) {
      revByMonth[mo][p.propertyId] = (revByMonth[mo][p.propertyId] || 0) + p.amount;
    }
  });

  // Nights sold & ADR from payments (airbnbNights field)
  let totalNights = 0;
  let nightsWithADR = 0;
  let adrSum = 0;
  payments.forEach(p => {
    const n = p.airbnbNights || 0;
    totalNights += n;
    if (n > 0 && p.avgNightlyRate) { adrSum += p.avgNightlyRate * n; nightsWithADR += n; }
  });
  const avgADR = nightsWithADR > 0 ? adrSum / nightsWithADR : 0;

  // Occupancy: blocked nights from iCal vs total days in year
  const occByProp = new Map();
  props.forEach(p => {
    const cal = getCalendar(p.id);
    const blocks = cal?.blocks || [];
    let blocked = 0, total = 0;
    for (let m = 0; m < 12; m++) {
      total   += daysInMonth(yr, m);
      blocked += countBlockedNights(blocks, yr, m);
    }
    occByProp.set(p.id, { blocked, total, pct: total > 0 ? blocked / total * 100 : 0 });
  });
  const totalDays    = [...occByProp.values()].reduce((s, v) => s + v.total, 0);
  const totalBlocked = [...occByProp.values()].reduce((s, v) => s + v.blocked, 0);
  const avgOcc = totalDays > 0 ? totalBlocked / totalDays * 100 : 0;

  // Target revenue: sum of confirmed targetADR × blocked nights per month
  let targetRev = 0;
  props.forEach(prop => {
    const cal = getCalendar(prop.id);
    for (let m = 0; m < 12; m++) {
      const mk = `${year}-${String(m + 1).padStart(2, '0')}`;
      const t  = getTargetADR(prop.id, mk);
      if (t) {
        const nights = countBlockedNights(cal?.blocks || [], yr, m);
        targetRev += (t.targetADR || 0) * nights;
      }
    }
  });

  // Prev year for deltas
  const prevYearPayments = getPaymentsForYear(String(yr - 1));
  const prevRev = prevYearPayments.reduce((s, p) => s + p.amount, 0);
  let prevNights = 0;
  prevYearPayments.forEach(p => { prevNights += (p.airbnbNights || 0); });

  return {
    payments, props, revByProp, totalRev, revByMonth,
    totalNights, avgADR, avgOcc, occByProp, targetRev,
    prevRev, prevNights
  };
}

// ── Property spotlight data ───────────────────────────────────────────────────
function getSpotlightData(propId, year) {
  const yr = parseInt(year, 10);
  const payments = getPaymentsForYear(year).filter(p => p.propertyId === propId);
  const cal = getCalendar(propId);
  const blocks = cal?.blocks || [];

  const months = Array.from({ length: 12 }, (_, m) => {
    const mk       = `${year}-${String(m + 1).padStart(2, '0')}`;
    const target   = getTargetADR(propId, mk);
    const paysInMo = payments.filter(p => (p.date || '').startsWith(mk));
    const rev      = paysInMo.reduce((s, p) => s + p.amount, 0);
    const nights   = paysInMo.reduce((s, p) => s + (p.airbnbNights || 0), 0);
    const adr      = nights > 0 ? paysInMo.reduce((s, p) => s + (p.avgNightlyRate || 0) * (p.airbnbNights || 0), 0) / nights : 0;
    const blocked  = countBlockedNights(blocks, yr, m);
    const total    = daysInMonth(yr, m);
    const occ      = total > 0 ? blocked / total * 100 : 0;
    return { mk, label: ML[m], target: target?.targetADR || null, rev, nights, adr, blocked, total, occ };
  });

  const totalRev    = months.reduce((s, m) => s + m.rev, 0);
  const totalNights = months.reduce((s, m) => s + m.nights, 0);
  const avgADR      = totalNights > 0 ? months.reduce((s, m) => s + m.adr * m.nights, 0) / totalNights : 0;
  const targetRev   = months.reduce((s, m) => s + (m.target || 0) * m.blocked, 0);

  return { months, totalRev, totalNights, avgADR, targetRev };
}

// ── Forward pipeline (next 90 days) ──────────────────────────────────────────
function getForwardPipeline() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end90 = new Date(today);
  end90.setDate(today.getDate() + 90);

  const props = getStrProps();
  const globalDisc = state.db.settings?.airbnb?.globalDiscountPct ?? 0;
  const targets = state.db.strRateTargets || [];
  const results = [];

  props.forEach(prop => {
    const cal = getCalendar(prop.id);
    const blocks = (cal?.blocks || []).filter(b => {
      if (!b.start || !b.end) return false;
      const bs = new Date(b.start);
      const be = new Date(b.end);
      return be > today && bs < end90;
    });

    let lockedNights = 0;
    let lockedRevMin = 0; // at published rate
    let openNights   = 0;
    let potRevMax    = 0; // open nights × best available target

    // Count locked nights from iCal blocks
    blocks.forEach(b => {
      const bs = new Date(b.start > today.toISOString().slice(0,10) ? b.start : today.toISOString().slice(0,10));
      const be = new Date(b.end);
      const clampedEnd = be < end90 ? be : end90;
      const nights = Math.round((clampedEnd - bs) / 86400000);
      if (nights > 0) {
        lockedNights += nights;
        // Get target ADR for the month of check-in
        const mk = b.start.slice(0, 7);
        const t  = targets.find(t => t.propertyId === prop.id && t.month === mk);
        const disc = (t?.discountPct != null ? t.discountPct : globalDisc) / 100;
        const rate = t ? (t.targetADR || 0) * (1 - disc) : 0;
        lockedRevMin += rate * nights;
      }
    });

    // Count open nights (not blocked) in next 90 days
    const d = new Date(today);
    while (d < end90) {
      const ds = d.toISOString().slice(0, 10);
      const isBlocked = blocks.some(b => ds >= b.start && ds < b.end);
      if (!isBlocked) {
        openNights++;
        const mk = ds.slice(0, 7);
        const t  = targets.find(t => t.propertyId === prop.id && t.month === mk);
        if (t) potRevMax += (t.targetADR || 0);
      }
      d.setDate(d.getDate() + 1);
    }

    results.push({
      propId: prop.id,
      propName: prop.name,
      lockedNights,
      lockedRevMin,
      openNights,
      potRevMax
    });
  });

  return results;
}

// ── Rebuild ───────────────────────────────────────────────────────────────────
let _container = null;

function rebuildView() {
  if (!_container) return;
  _container.innerHTML = '';
  _container.appendChild(buildView());
}

// ── Main view builder ─────────────────────────────────────────────────────────
function buildView() {
  _container = el('div', { class: 'view-content' });
  const data = getPortfolioData(gYear);

  // ── Page header + year filter
  const header = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:20px' });
  const titleWrap = el('div');
  titleWrap.appendChild(el('h2', { style: 'margin:0;font-size:20px;font-weight:700' }, 'STR Performance'));
  titleWrap.appendChild(el('p', { style: 'margin:2px 0 0;font-size:13px;color:var(--text-muted)' },
    `${data.props.length} short-term rental propert${data.props.length !== 1 ? 'ies' : 'y'} · ${data.payments.length} bookings`
  ));
  header.appendChild(titleWrap);

  const yearSel = el('select', {
    style: 'background:var(--bg-elev-1);border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 10px;font-size:12px;color:var(--text);cursor:pointer'
  });
  const years = getDataYears();
  years.forEach(y => {
    const o = el('option', { value: y }, y);
    if (y === gYear) o.selected = true;
    yearSel.appendChild(o);
  });
  yearSel.addEventListener('change', () => { gYear = yearSel.value; rebuildView(); });
  header.appendChild(yearSel);
  _container.appendChild(header);

  if (!data.props.length) {
    _container.appendChild(mkEmptyState('No short-term rental properties found.'));
    return _container;
  }

  // ── Section 1: Portfolio KPI row
  _container.appendChild(buildPortfolioKpis(data));

  // ── Section 2: Revenue trend + Occupancy side-by-side
  const twoCol = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px' });
  twoCol.appendChild(buildRevTrendCard(data));
  twoCol.appendChild(buildOccupancyCard(data));
  _container.appendChild(twoCol);

  // ── Section 3: Property comparison table
  _container.appendChild(buildComparisonTable(data));

  // ── Section 4: Property spotlight
  _container.appendChild(buildSpotlightSection(data.props));

  // ── Section 5: Forward pipeline
  _container.appendChild(buildForwardPipelineCard());

  return _container;
}

// ── Helper: available years from STR payments
function getDataYears() {
  const y = new Set();
  listActivePayments()
    .filter(p => p.stream === 'short_term_rental')
    .forEach(p => { const yr = (p.date || '').slice(0, 4); if (yr >= '2000') y.add(yr); });
  if (!y.size) y.add(String(new Date().getFullYear()));
  return [...y].sort().reverse();
}

// ── Portfolio KPI row ─────────────────────────────────────────────────────────
function buildPortfolioKpis(data) {
  const { totalRev, prevRev, totalNights, prevNights, avgADR, avgOcc, targetRev, payments, props } = data;
  const vsTarget = targetRev > 0 ? (totalRev / targetRev) * 100 : null;
  const propCount = props.length;

  const grid = el('div', {
    style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:16px'
  });

  // 1. Total Revenue
  grid.appendChild(mkKpiCard({
    label: 'Total Revenue',
    value: formatEUR(totalRev),
    subtitle: `${gYear} · ${payments.length} bookings`,
    delta: safePct(totalRev, prevRev),
    compLabel: String(parseInt(gYear) - 1),
    compValue: prevRev > 0 ? formatEUR(prevRev) : undefined,
    onClick: () => openRevenueModal(data)
  }));

  // 2. Nights Sold
  grid.appendChild(mkKpiCard({
    label: 'Nights Sold',
    value: totalNights.toLocaleString(),
    subtitle: `${propCount} propert${propCount !== 1 ? 'ies' : 'y'}`,
    delta: safePct(totalNights, prevNights),
    compLabel: String(parseInt(gYear) - 1),
    onClick: () => openNightsModal(data)
  }));

  // 3. Avg ADR (achieved)
  grid.appendChild(mkKpiCard({
    label: 'Avg ADR (Achieved)',
    value: avgADR > 0 ? formatEUR(avgADR, { maxFrac: 0 }) : '—',
    subtitle: 'Avg nightly rate across bookings',
    onClick: () => openADRModal(data)
  }));

  // 4. Avg Occupancy
  grid.appendChild(mkKpiCard({
    label: 'Avg Occupancy',
    value: avgOcc > 0 ? avgOcc.toFixed(1) + '%' : '—',
    subtitle: 'Blocked nights ÷ total days (iCal)',
    variant: avgOcc >= 70 ? 'success' : avgOcc >= 40 ? undefined : 'warning',
    onClick: () => openOccModal(data)
  }));

  // 5. Revenue vs Target
  if (targetRev > 0) {
    grid.appendChild(mkKpiCard({
      label: 'Revenue vs Target',
      value: vsTarget != null ? vsTarget.toFixed(1) + '%' : '—',
      subtitle: `Target: ${formatEUR(targetRev, { maxFrac: 0 })}`,
      variant: vsTarget != null && vsTarget >= 90 ? 'success' : vsTarget != null && vsTarget < 70 ? 'danger' : undefined,
      onClick: () => openTargetModal(data)
    }));
  }

  // 6. Avg Rev / Property
  if (propCount > 1) {
    grid.appendChild(mkKpiCard({
      label: 'Avg Rev / Property',
      value: formatEUR(totalRev / propCount, { maxFrac: 0 }),
      subtitle: `Across ${propCount} STR properties`
    }));
  }

  return grid;
}

// ── Revenue trend chart card ──────────────────────────────────────────────────
function buildRevTrendCard(data) {
  const { revByMonth, props } = data;
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Monthly Revenue')
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });
  const wrap = el('div', { class: 'chart-wrap', style: 'height:220px' });
  wrap.appendChild(el('canvas', { id: 'str-rev-trend' }));
  body.appendChild(wrap);
  card.appendChild(body);

  // Render chart after DOM insertion
  requestAnimationFrame(() => {
    charts.bar('str-rev-trend', {
      labels: ML,
      stacked: true,
      datasets: props.map((p, i) => ({
        label: shortName(p.name),
        data: revByMonth.map(mo => mo[p.id] || 0),
        backgroundColor: PROP_COLORS[i % PROP_COLORS.length] + 'cc'
      })),
      onClickItem: (label, idx) => openMonthRevenueModal(label, idx, data)
    });
  });
  return card;
}

// ── Occupancy chart card ──────────────────────────────────────────────────────
function buildOccupancyCard(data) {
  const { occByProp, props } = data;
  const yr = parseInt(gYear, 10);
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Occupancy Rate by Property')
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });

  // Mini occupancy bars
  const list = el('div', { style: 'display:flex;flex-direction:column;gap:10px;padding:8px 0' });
  props.forEach((p, i) => {
    const occ = occByProp.get(p.id) || { pct: 0, blocked: 0, total: 0 };
    const row = el('div');
    const labelRow = el('div', { style: 'display:flex;justify-content:space-between;margin-bottom:4px' });
    labelRow.appendChild(el('span', { style: 'font-size:12px;color:var(--text)' }, shortName(p.name)));
    labelRow.appendChild(el('span', { style: 'font-size:12px;font-weight:600;color:var(--text)' },
      occ.pct.toFixed(1) + '%'
    ));
    row.appendChild(labelRow);
    row.appendChild(mkProgressBar(occ.pct, PROP_COLORS[i % PROP_COLORS.length]));
    const sub = el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:3px' },
      `${occ.blocked} booked / ${occ.total} days`
    );
    row.appendChild(sub);
    list.appendChild(row);
  });
  body.appendChild(list);
  card.appendChild(body);
  return card;
}

// ── Property comparison table ─────────────────────────────────────────────────
function buildComparisonTable(data) {
  const { props, revByProp, occByProp, payments, totalRev } = data;
  const card = el('div', { class: 'card', style: 'margin-bottom:16px' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Property Comparison')
  ));
  const body = el('div', { style: 'padding:0 16px 16px;overflow-x:auto' });

  const rows = props.map((p, i) => {
    const rev   = revByProp.get(p.id) || 0;
    const occ   = occByProp.get(p.id) || { pct: 0, blocked: 0 };
    const pPays = payments.filter(pay => pay.propertyId === p.id);
    const nights = pPays.reduce((s, pay) => s + (pay.airbnbNights || 0), 0);
    const adr   = nights > 0
      ? pPays.reduce((s, pay) => s + (pay.avgNightlyRate || 0) * (pay.airbnbNights || 0), 0) / nights
      : 0;
    const revPct = totalRev > 0 ? rev / totalRev * 100 : 0;

    const nameCell = el('td', { style: 'padding:8px;font-size:12px;color:var(--text)' });
    const dot = el('span', {
      style: `display:inline-block;width:8px;height:8px;border-radius:50%;background:${PROP_COLORS[i % PROP_COLORS.length]};margin-right:6px;flex-shrink:0`
    });
    nameCell.appendChild(dot);
    nameCell.appendChild(document.createTextNode(shortName(p.name)));

    const revBar = el('td', { style: 'padding:8px;min-width:120px' });
    const barWrap = el('div', { style: 'display:flex;align-items:center;gap:6px' });
    barWrap.appendChild(mkProgressBar(revPct, PROP_COLORS[i % PROP_COLORS.length]));
    barWrap.appendChild(el('span', { style: 'font-size:11px;color:var(--text-muted);white-space:nowrap' }, formatEUR(rev, { maxFrac: 0 })));
    revBar.appendChild(barWrap);

    return el('tr', { style: i % 2 === 1 ? 'background:rgba(255,255,255,0.02)' : '' },
      nameCell,
      revBar,
      mkTd(nights > 0 ? nights.toString() : '—'),
      mkTd(adr > 0 ? formatEUR(adr, { maxFrac: 0 }) : '—'),
      mkTd(occ.pct.toFixed(1) + '%'),
      mkTd(pPays.length.toString())
    );
  });

  const thead = el('thead');
  const hrow = el('tr');
  ['Property', 'Revenue', 'Nights', 'Avg ADR', 'Occupancy', 'Bookings'].forEach((h, hi) => {
    hrow.appendChild(el('th', {
      style: `padding:6px 8px;text-align:${hi === 0 ? 'left' : 'right'};font-size:11px;color:var(--text-muted);border-bottom:1px solid rgba(255,255,255,0.08);white-space:nowrap`
    }, h));
  });
  thead.appendChild(hrow);

  const tbody = el('tbody');
  rows.forEach(r => tbody.appendChild(r));

  const table = el('table', { style: 'width:100%;border-collapse:collapse;font-size:12px' });
  table.appendChild(thead);
  table.appendChild(tbody);
  body.appendChild(table);
  card.appendChild(body);
  return card;
}

function mkTd(text) {
  return el('td', { style: 'padding:8px;text-align:right;font-size:12px;color:var(--text)' }, text);
}

// ── Property spotlight section ────────────────────────────────────────────────
function buildSpotlightSection(props) {
  if (!gSpotlightPropId && props.length) gSpotlightPropId = props[0].id;

  const wrap = el('div', { style: 'margin-bottom:16px' });
  const sectionHeader = el('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:12px' });
  sectionHeader.appendChild(el('div', { style: 'font-size:15px;font-weight:700;color:var(--text)' }, 'Property Spotlight'));

  const sel = el('select', {
    style: 'background:var(--bg-elev-1);border:1px solid var(--border);border-radius:var(--radius-sm);padding:5px 10px;font-size:12px;color:var(--text);cursor:pointer'
  });
  props.forEach(p => {
    const o = el('option', { value: p.id }, shortName(p.name));
    if (p.id === gSpotlightPropId) o.selected = true;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => {
    gSpotlightPropId = sel.value;
    const existing = document.getElementById('str-spotlight-content');
    if (existing) {
      const newContent = buildSpotlightContent(gSpotlightPropId);
      newContent.id = 'str-spotlight-content';
      existing.replaceWith(newContent);
    }
  });
  sectionHeader.appendChild(sel);
  wrap.appendChild(sectionHeader);

  const content = buildSpotlightContent(gSpotlightPropId);
  content.id = 'str-spotlight-content';
  wrap.appendChild(content);
  return wrap;
}

function buildSpotlightContent(propId) {
  if (!propId) return el('div');
  const data = getSpotlightData(propId, gYear);
  const { months, totalRev, totalNights, avgADR, targetRev } = data;

  const wrap = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px' });

  // ADR chart: Achieved vs Target
  const adrCard = el('div', { class: 'card' });
  adrCard.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'ADR: Achieved vs Target')
  ));
  const adrBody = el('div', { style: 'padding:0 16px 16px' });
  const adrWrap = el('div', { class: 'chart-wrap', style: 'height:200px' });
  adrWrap.appendChild(el('canvas', { id: 'str-spotlight-adr' }));
  adrBody.appendChild(adrWrap);

  // Summary row below chart
  const adrSummary = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px' });
  adrSummary.appendChild(mkSummaryBox('Total Revenue', formatEUR(totalRev, { maxFrac: 0 }), gYear));
  adrSummary.appendChild(mkSummaryBox('Target Revenue', targetRev > 0 ? formatEUR(targetRev, { maxFrac: 0 }) : '—', 'confirmed months'));
  adrSummary.appendChild(mkSummaryBox('Avg ADR', avgADR > 0 ? formatEUR(avgADR, { maxFrac: 0 }) : '—', 'from bookings'));
  adrBody.appendChild(adrSummary);
  adrCard.appendChild(adrBody);

  // Occupancy by month chart
  const occCard = el('div', { class: 'card' });
  occCard.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Monthly Occupancy %')
  ));
  const occBody = el('div', { style: 'padding:0 16px 16px' });
  const occWrap = el('div', { class: 'chart-wrap', style: 'height:200px' });
  occWrap.appendChild(el('canvas', { id: 'str-spotlight-occ' }));
  occBody.appendChild(occWrap);

  const occSummary = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px' });
  occSummary.appendChild(mkSummaryBox('Nights Sold', totalNights.toString(), 'from bookings'));
  const blockedTotal = months.reduce((s, m) => s + m.blocked, 0);
  const daysTotal    = months.reduce((s, m) => s + m.total, 0);
  const yearOcc = daysTotal > 0 ? (blockedTotal / daysTotal * 100).toFixed(1) + '%' : '—';
  occSummary.appendChild(mkSummaryBox('Year Occupancy', yearOcc, 'iCal blocked nights'));
  const bookings = getPaymentsForYear(gYear).filter(p => p.propertyId === propId).length;
  occSummary.appendChild(mkSummaryBox('Bookings', bookings.toString(), gYear));
  occBody.appendChild(occSummary);
  occCard.appendChild(occBody);

  wrap.appendChild(adrCard);
  wrap.appendChild(occCard);

  // Render charts after DOM
  requestAnimationFrame(() => {
    charts.destroy('str-spotlight-adr');
    charts.destroy('str-spotlight-occ');

    const hasTarget = months.some(m => m.target != null);
    const adrDatasets = [
      {
        label: 'Achieved ADR',
        data: months.map(m => m.adr > 0 ? m.adr : null),
        backgroundColor: '#6366f1aa',
        borderColor: '#6366f1',
        type: 'bar'
      }
    ];
    if (hasTarget) {
      adrDatasets.push({
        label: 'Target ADR',
        data: months.map(m => m.target),
        borderColor: '#f59e0b',
        backgroundColor: 'transparent',
        type: 'line',
        borderWidth: 2,
        pointRadius: 3,
        tension: 0.3,
        fill: false
      });
    }
    charts.bar('str-spotlight-adr', {
      labels: ML,
      datasets: adrDatasets,
      onClickItem: (label, idx) => openMonthSpotlightModal(label, idx, propId, months)
    });

    charts.bar('str-spotlight-occ', {
      labels: ML,
      datasets: [{
        label: 'Occupancy %',
        data: months.map(m => m.occ),
        backgroundColor: months.map(m =>
          m.occ >= 70 ? '#22c55ecc' : m.occ >= 40 ? '#6366f1cc' : '#f59e0bcc'
        )
      }],
      onClickItem: (label, idx) => openMonthSpotlightModal(label, idx, propId, months)
    });
  });

  return wrap;
}

// ── Forward pipeline card ─────────────────────────────────────────────────────
function buildForwardPipelineCard() {
  const pipeline = getForwardPipeline();
  const card = el('div', { class: 'card', style: 'margin-bottom:16px' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Forward Pipeline — Next 90 Days'),
    el('div', { class: 'card-subtitle' }, new Date().toISOString().slice(0,10) + ' → ' + (() => { const d = new Date(); d.setDate(d.getDate()+90); return d.toISOString().slice(0,10); })())
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });

  const totalLocked = pipeline.reduce((s, r) => s + r.lockedNights, 0);
  const totalLockedRev = pipeline.reduce((s, r) => s + r.lockedRevMin, 0);
  const totalOpen = pipeline.reduce((s, r) => s + r.openNights, 0);
  const totalPot  = pipeline.reduce((s, r) => s + r.potRevMax, 0);

  // Summary row
  const sumGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px' });
  sumGrid.appendChild(mkSummaryBox('Locked Nights', totalLocked.toString(), 'confirmed bookings'));
  sumGrid.appendChild(mkSummaryBox('Locked Revenue', totalLockedRev > 0 ? formatEUR(totalLockedRev, { maxFrac: 0 }) : '—', 'at published rate'));
  sumGrid.appendChild(mkSummaryBox('Open Nights', totalOpen.toString(), 'available to book'));
  sumGrid.appendChild(mkSummaryBox('Revenue Potential', totalPot > 0 ? formatEUR(totalPot, { maxFrac: 0 }) : '—', 'open × target ADR'));
  body.appendChild(sumGrid);

  // Per-property breakdown
  if (pipeline.length) {
    body.appendChild(mkModalTable(
      [
        { label: 'Property', right: false },
        { label: 'Locked Nights', right: true },
        { label: 'Locked Rev', right: true },
        { label: 'Open Nights', right: true },
        { label: 'Rev Potential', right: true }
      ],
      pipeline.map(r => [
        shortName(r.propName),
        r.lockedNights.toString(),
        r.lockedRevMin > 0 ? formatEUR(r.lockedRevMin, { maxFrac: 0 }) : '—',
        r.openNights.toString(),
        r.potRevMax > 0 ? formatEUR(r.potRevMax, { maxFrac: 0 }) : '—'
      ])
    ));
  }

  card.appendChild(body);
  return card;
}

// ── Modal drill-downs ─────────────────────────────────────────────────────────
function openRevenueModal(data) {
  const { payments, props, revByProp, totalRev } = data;
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

  body.appendChild(mkSummaryGrid([
    { label: 'Total Revenue', value: formatEUR(totalRev) },
    { label: 'Bookings', value: payments.length.toString() }
  ], 2));

  body.appendChild(mkSectionLabel('Revenue by Property'));
  body.appendChild(mkModalTable(
    ['Property', 'Revenue', '% of Total', 'Bookings'],
    props.map(p => {
      const rev  = revByProp.get(p.id) || 0;
      const pPays = payments.filter(pay => pay.propertyId === p.id);
      return [shortName(p.name), formatEUR(rev), totalRev > 0 ? (rev / totalRev * 100).toFixed(1) + '%' : '—', pPays.length.toString()];
    }),
    { highlight: 1 }
  ));

  body.appendChild(mkSectionLabel(`Top Bookings — ${gYear}`));
  const top = [...payments].sort((a, b) => b.amount - a.amount).slice(0, 10);
  body.appendChild(mkModalTable(
    ['Date', 'Property', 'Nights', 'Amount'],
    top.map(p => [
      p.date || '—',
      shortName(byId('properties', p.propertyId)?.name || '—'),
      (p.airbnbNights || '—').toString(),
      formatEUR(p.amount)
    ]),
    { highlight: 3 }
  ));

  openModal({ title: `STR Revenue — ${gYear}`, body, large: true });
}

function openNightsModal(data) {
  const { payments, props } = data;
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

  const rows = props.map(p => {
    const pPays = payments.filter(pay => pay.propertyId === p.id);
    const nights = pPays.reduce((s, pay) => s + (pay.airbnbNights || 0), 0);
    return [shortName(p.name), nights.toString(), pPays.length.toString()];
  });
  body.appendChild(mkModalTable(['Property', 'Nights Sold', 'Bookings'], rows, { highlight: 1 }));

  const totalNights = data.totalNights;
  body.appendChild(mkSectionLabel('Monthly Breakdown (All Properties)'));
  const byMonth = Array(12).fill(0);
  payments.forEach(p => {
    const m = parseInt((p.date || '').slice(5, 7), 10) - 1;
    if (m >= 0 && m < 12) byMonth[m] += (p.airbnbNights || 0);
  });
  body.appendChild(mkModalTable(
    ['Month', 'Nights Sold'],
    byMonth.map((n, i) => [ML[i], n > 0 ? n.toString() : '—']),
    { highlight: 1 }
  ));

  openModal({ title: `Nights Sold — ${gYear}`, body, large: true });
}

function openADRModal(data) {
  const { payments, props } = data;
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

  body.appendChild(mkSectionLabel('ADR by Property'));
  body.appendChild(mkModalTable(
    ['Property', 'Avg ADR', 'Nights', 'Bookings'],
    props.map(p => {
      const pPays = payments.filter(pay => pay.propertyId === p.id);
      const nights = pPays.reduce((s, pay) => s + (pay.airbnbNights || 0), 0);
      const adr = nights > 0
        ? pPays.reduce((s, pay) => s + (pay.avgNightlyRate || 0) * (pay.airbnbNights || 0), 0) / nights
        : 0;
      return [shortName(p.name), adr > 0 ? formatEUR(adr) : '—', nights.toString(), pPays.length.toString()];
    }),
    { highlight: 1 }
  ));

  openModal({ title: `ADR Breakdown — ${gYear}`, body, large: true });
}

function openOccModal(data) {
  const { props, occByProp } = data;
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

  body.appendChild(mkModalTable(
    ['Property', 'Occupancy %', 'Blocked Nights', 'Total Days'],
    props.map(p => {
      const occ = occByProp.get(p.id) || { pct: 0, blocked: 0, total: 0 };
      return [shortName(p.name), occ.pct.toFixed(1) + '%', occ.blocked.toString(), occ.total.toString()];
    }),
    { highlight: 1 }
  ));

  openModal({ title: `Occupancy — ${gYear}`, body, large: true });
}

function openTargetModal(data) {
  const { props, revByProp, targetRev, totalRev } = data;
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

  body.appendChild(mkSummaryGrid([
    { label: 'Actual Revenue', value: formatEUR(totalRev) },
    { label: 'Target Revenue', value: formatEUR(targetRev) },
    { label: 'Achievement', value: targetRev > 0 ? (totalRev / targetRev * 100).toFixed(1) + '%' : '—' },
    { label: 'Variance', value: formatEUR(totalRev - targetRev) }
  ], 4));

  body.appendChild(mkSectionLabel('By Property'));
  const targets = state.db.strRateTargets || [];
  body.appendChild(mkModalTable(
    ['Property', 'Actual', 'Target', 'Achievement'],
    props.map(p => {
      const rev    = revByProp.get(p.id) || 0;
      const cal    = getCalendar(p.id);
      const yr = parseInt(gYear, 10);
      let propTarget = 0;
      for (let m = 0; m < 12; m++) {
        const mk = `${gYear}-${String(m + 1).padStart(2, '0')}`;
        const t  = targets.find(t => t.propertyId === p.id && t.month === mk);
        if (t) propTarget += (t.targetADR || 0) * countBlockedNights(cal?.blocks || [], yr, m);
      }
      const ach = propTarget > 0 ? (rev / propTarget * 100).toFixed(1) + '%' : '—';
      return [shortName(p.name), formatEUR(rev), propTarget > 0 ? formatEUR(propTarget) : '—', ach];
    }),
    { highlight: 2 }
  ));

  openModal({ title: `Revenue vs Target — ${gYear}`, body, large: true });
}

function openMonthRevenueModal(monthLabel, monthIdx, data) {
  const { payments, props } = data;
  const mk = `${gYear}-${String(monthIdx + 1).padStart(2, '0')}`;
  const moPays = payments.filter(p => (p.date || '').startsWith(mk));
  const moRev  = moPays.reduce((s, p) => s + p.amount, 0);

  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  body.appendChild(mkSummaryGrid([
    { label: 'Total Revenue', value: formatEUR(moRev) },
    { label: 'Bookings',      value: moPays.length.toString() }
  ], 2));

  if (moPays.length) {
    body.appendChild(mkModalTable(
      ['Check-in', 'Property', 'Nights', 'Amount'],
      [...moPays].sort((a, b) => (a.airbnbCheckIn || a.date) < (b.airbnbCheckIn || b.date) ? -1 : 1).map(p => [
        p.airbnbCheckIn || p.date || '—',
        shortName(byId('properties', p.propertyId)?.name || '—'),
        (p.airbnbNights || '—').toString(),
        formatEUR(p.amount)
      ]),
      { highlight: 3 }
    ));
  } else {
    body.appendChild(mkEmptyState('No bookings in this month.'));
  }

  openModal({ title: `${monthLabel} ${gYear} — STR Revenue`, body, large: true });
}

function openMonthSpotlightModal(monthLabel, monthIdx, propId, months) {
  const mo = months[monthIdx];
  if (!mo) return;
  const prop = byId('properties', propId);
  const pays = getPaymentsForYear(gYear).filter(p =>
    p.propertyId === propId && (p.date || '').startsWith(mo.mk)
  );

  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  body.appendChild(mkSummaryGrid([
    { label: 'Revenue',        value: formatEUR(mo.rev) },
    { label: 'Achieved ADR',   value: mo.adr > 0 ? formatEUR(mo.adr) : '—' },
    { label: 'Target ADR',     value: mo.target != null ? formatEUR(mo.target) : '—' },
    { label: 'Occupancy',      value: mo.occ.toFixed(1) + '%' },
    { label: 'Blocked Nights', value: mo.blocked.toString() },
    { label: 'Total Days',     value: mo.total.toString() }
  ], 3));

  if (pays.length) {
    body.appendChild(mkSectionLabel('Bookings'));
    body.appendChild(mkModalTable(
      ['Check-in', 'Check-out', 'Nights', 'ADR', 'Amount'],
      pays.map(p => [
        p.airbnbCheckIn || p.date || '—',
        p.airbnbCheckOut || '—',
        (p.airbnbNights || '—').toString(),
        p.avgNightlyRate ? formatEUR(p.avgNightlyRate) : '—',
        formatEUR(p.amount)
      ]),
      { highlight: 4 }
    ));
  } else {
    body.appendChild(mkEmptyState('No bookings recorded for this month.'));
  }

  openModal({ title: `${shortName(prop?.name || '')} — ${monthLabel} ${gYear}`, body, large: true });
}

// ── Utility ───────────────────────────────────────────────────────────────────
function shortName(name) {
  if (!name) return '—';
  const pipe = name.indexOf('|');
  return pipe > 0 ? name.slice(0, pipe).trim() : name;
}
