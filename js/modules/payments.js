// Payments module: manual payments, LT rental schedule, Airbnb CSV import
import { state, runBatch } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, select, selVals, input, formRow, textarea, button, fmtDate, today, drillDownModal, attachSortFilter, buildMultiSelect } from '../core/ui.js';
import { upsert, softDelete, listActive, listActivePayments, byId, newId, formatMoney, formatEUR, toEUR, generatePaymentSchedule, getOrCreateForecast, saveForecastMonth, applyReservationExpenseRules, removeReservationExpenses, deletePayment, buildGeneratedExpenseIndex, buildReservationExpenseRefMap } from '../core/data.js';
import { CURRENCIES, PAYMENT_STATUSES, STREAMS } from '../core/config.js';
import { navigate } from '../core/router.js';

let _allPaySortCol = -1, _allPaySortDir = 1;
let _allPayPage = 0, _allPayPageSize = 100, _allPaySearch = '';
let _schedSortCol  = -1, _schedSortDir  = 1;
let _upcomSortCol  = -1, _upcomSortDir  = 1;
let _payUpdateFn = null;

export default {
  id: 'payments',
  label: 'Property Payments',
  icon: 'P',
  render(container) { const { element, update } = build(); _payUpdateFn = update; container.appendChild(element); },
  refresh() {
    if (_payUpdateFn) { _payUpdateFn(); return; }
    const c = document.getElementById('content');
    c.innerHTML = '';
    const { element, update } = build();
    _payUpdateFn = update;
    c.appendChild(element);
  },
  destroy() { _payUpdateFn = null; }
};

function build() {
  const wrap = el('div', { class: 'view active' });

  const tabs = el('div', { class: 'tabs' });
  const allSection = el('div', {});
  const scheduleSection = el('div', { style: 'display:none' });
  const upcomingSection = el('div', { style: 'display:none' });

  const sections = [allSection, scheduleSection, upcomingSection];
  const tabEls = [
    el('div', { class: 'tab active' }, 'All Payments'),
    el('div', { class: 'tab' }, 'Rent Schedule'),
    el('div', { class: 'tab' }, 'Upcoming')
  ];

  let schedUpdate = null, upcomUpdate = null;

  tabEls.forEach((t, i) => {
    t.onclick = () => {
      tabEls.forEach(x => x.classList.remove('active')); t.classList.add('active');
      sections.forEach((s, j) => { s.style.display = j === i ? '' : 'none'; });
      if (i === 1 && !scheduleSection.dataset.built) { scheduleSection.dataset.built = '1'; schedUpdate = buildScheduleSection(scheduleSection); }
      if (i === 2 && !upcomingSection.dataset.built) { upcomingSection.dataset.built = '1'; upcomUpdate = buildUpcomingSection(upcomingSection); }
    };
    tabs.appendChild(t);
  });

  wrap.appendChild(tabs);
  sections.forEach(s => wrap.appendChild(s));

  const allPayUpdate = buildAllPayments(allSection);

  return {
    element: wrap,
    update: () => {
      allPayUpdate();
      if (schedUpdate) schedUpdate();
      if (upcomUpdate) upcomUpdate();
    }
  };
}

function buildAllPayments(wrap) {
  const filterBar = el('div', { class: 'flex gap-8 mb-16', style: 'flex-wrap:wrap' });
  const yearFilter   = new Set();
  const monthFilter  = new Set();
  const streamFilter = new Set();
  const propFilter   = new Set();
  const typeFilter   = new Set();
  const statusFilter = new Set();

  const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const STATUS_META = {
    paid:         { label: 'Paid',         css: 'success' },
    pending:      { label: 'Pending',      css: 'warning' },
    overdue:      { label: 'Overdue',      css: 'danger'  },
    materialized: { label: 'Sold', css: 'info'    }
  };

  const getPayType = p => p.source === 'airbnb' ? (p.airbnbType || p.type || 'other') : (p.type || 'other');

  const STREAM_LABELS = { short_term_rental: 'Short Term', long_term_rental: 'Long Term' };

  const matchesExcept = (p, skip) => {
    if (skip !== 'year'   && yearFilter.size   > 0 && !yearFilter.has(p.date?.slice(0, 4)))  return false;
    if (skip !== 'month'  && monthFilter.size  > 0 && !monthFilter.has(p.date?.slice(5, 7))) return false;
    if (skip !== 'stream' && streamFilter.size > 0 && !streamFilter.has(p.stream || ''))     return false;
    if (skip !== 'prop'   && propFilter.size   > 0 && !propFilter.has(p.propertyId))          return false;
    if (skip !== 'type'   && typeFilter.size   > 0 && !typeFilter.has(getPayType(p)))          return false;
    if (skip !== 'status' && statusFilter.size > 0 && !statusFilter.has(p.status))             return false;
    return true;
  };

  let _rtTimer;
  const debouncedRT = () => { clearTimeout(_rtTimer); _rtTimer = setTimeout(() => { rebuildFilters(); renderTable(); }, 250); };
  const yearMS   = buildMultiSelect([], yearFilter,   'All Years',      debouncedRT, 'pay_years');
  const monthMS  = buildMultiSelect([], monthFilter,  'All Months',     debouncedRT, 'pay_months');
  const streamMS = buildMultiSelect([], streamFilter, 'All Streams',    debouncedRT, 'pay_streams');
  const propMS   = buildMultiSelect([], propFilter,   'All Properties', debouncedRT, 'pay_props');
  const typeMS   = buildMultiSelect([], typeFilter,   'All Types',      debouncedRT, 'pay_types');
  const statusMS = buildMultiSelect([], statusFilter, 'All Statuses',   debouncedRT, 'pay_statuses');

  const rebuildFilters = () => {
    const allPayments = listActivePayments();
    const allProps    = listActive('properties');
    const ys = new Set(), ms = new Set(), strs = new Set(), ps = new Set(), ts = new Set(), ss = new Set();
    for (const p of allPayments) {
      if (matchesExcept(p, 'year'))   { if (p.date?.slice(0, 4)) ys.add(p.date.slice(0, 4)); }
      if (matchesExcept(p, 'month'))  { if (p.date?.slice(5, 7)) ms.add(p.date.slice(5, 7)); }
      if (matchesExcept(p, 'stream')) { strs.add(p.stream || ''); }
      if (matchesExcept(p, 'prop'))   { if (p.propertyId) ps.add(p.propertyId); }
      if (matchesExcept(p, 'type'))   { ts.add(getPayType(p)); }
      if (matchesExcept(p, 'status')) { if (p.status) ss.add(p.status); }
    }
    yearMS.setItems([...ys].sort().reverse().map(y => ({ value: y, label: y })));
    monthMS.setItems([...ms].sort().map(m => ({ value: m, label: MONTH_LABELS[parseInt(m, 10) - 1] })));
    streamMS.setItems([...strs].filter(Boolean).sort().map(s => ({ value: s, label: STREAM_LABELS[s] || s })));
    propMS.setItems([...ps].map(id => allProps.find(pr => pr.id === id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name)).map(pr => ({ value: pr.id, label: pr.name })));
    typeMS.setItems([...ts].sort().map(t => ({ value: t, label: t })));
    statusMS.setItems([...ss].sort().map(s => { const m = STATUS_META[s] || { label: s, css: '' }; return { value: s, label: m.label, css: m.css }; }));
  };

  let selected = new Set();

  const deleteSelBtn = button('', { variant: 'danger', onClick: async () => {
    const count = selected.size;
    if (!count) return;
    const ok = await confirmDialog(`Delete ${count} payment(s)? This cannot be undone.`, { danger: true, okLabel: `Delete ${count}` });
    if (!ok) return;
    // Collect affected pending Airbnb months before deleting
    const affectedForecast = new Set();
    const payMap = new Map(listActivePayments().map(p => [p.id, p]));
    for (const id of [...selected]) {
      const p = payMap.get(id);
      if (p?.source === 'airbnb' && p?.status === 'pending') {
        const mk = (p.airbnbCheckIn || p.date || '').slice(0, 7);
        if (mk) affectedForecast.add(`${p.propertyId}|${mk}`);
      }
    }
    const refMap = buildReservationExpenseRefMap();
    runBatch(() => {
      for (const id of [...selected]) {
        const p = payMap.get(id);
        if (p) removeReservationExpenses(p, refMap);
        softDelete('payments', id);
      }
      for (const key of affectedForecast) {
        const [propId, monthKey] = key.split('|');
        recalcPendingAirbnbForecast(propId, monthKey);
      }
    });
    selected.clear();
    toast(`Deleted ${count} payment(s)`, 'success');
    renderTable();
  }});
  deleteSelBtn.style.display = 'none';

  const resetFiltersBtn = button('Reset Filters', { variant: 'sm ghost', onClick: () => { yearMS.reset(); monthMS.reset(); streamMS.reset(); propMS.reset(); typeMS.reset(); statusMS.reset(); rebuildFilters(); renderTable(); } });
  filterBar.appendChild(yearMS);
  filterBar.appendChild(monthMS);
  filterBar.appendChild(streamMS);
  filterBar.appendChild(propMS);
  filterBar.appendChild(typeMS);
  filterBar.appendChild(statusMS);
  filterBar.appendChild(resetFiltersBtn);
  filterBar.appendChild(el('div', { class: 'flex-1' }));
  filterBar.appendChild(deleteSelBtn);
  filterBar.appendChild(button('Import Airbnb CSV', { onClick: () => openCSVImport() }));
  filterBar.appendChild(button('Export CSV', { onClick: () => exportCSV() }));
  filterBar.appendChild(button('+ Add Payment', { variant: 'primary', onClick: () => openForm() }));
  wrap.appendChild(filterBar);

  // Data-level search box (filters the whole dataset, not just the visible page)
  const searchWrap = el('div', { style: 'display:flex;justify-content:flex-end;margin-bottom:8px' });
  const searchInput = el('input', { type: 'search', class: 'input', placeholder: 'Filter payments…', style: 'max-width:220px;font-size:13px' });
  searchInput.value = _allPaySearch;
  searchWrap.appendChild(searchInput);
  wrap.appendChild(searchWrap);

  const tableWrap = el('div', { class: 'table-wrap' });
  wrap.appendChild(tableWrap);

  const pagerWrap = el('div', { class: 'flex justify-between', style: 'align-items:center;margin-top:10px;flex-wrap:wrap;gap:8px' });
  wrap.appendChild(pagerWrap);

  let _searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => { _allPaySearch = searchInput.value.trim().toLowerCase(); _allPayPage = 0; renderTable(); }, 200);
  });

  const syncDeleteBtn = () => {
    if (selected.size > 0) {
      deleteSelBtn.textContent = `Delete ${selected.size} Selected`;
      deleteSelBtn.style.display = '';
    } else {
      deleteSelBtn.style.display = 'none';
    }
  };

  const PAGE_SIZES = [50, 100, 250, 500];

  // Derive a payment's display + sort/search values once, reused by every consumer.
  const derive = (r) => {
    const prop  = byId('properties', r.propertyId);
    const sMeta = STATUS_META[r.status] || { label: r.status, css: '' };
    const rType = (r.source === 'airbnb' ? (r.airbnbType || r.type) : (r.type || '')).toLowerCase();
    const isNegDisplay  = rType === 'resolution adjustment' || rType === 'adjustment';
    const isReservation = rType === 'reservation';
    const dispAmt   = isNegDisplay ? -Math.abs(r.amount) : r.amount;
    const dispGross = r.airbnbGrossEarnings != null ? (isNegDisplay ? -Math.abs(r.airbnbGrossEarnings) : r.airbnbGrossEarnings) : null;
    const typeLabel = r.source === 'airbnb' ? (r.airbnbType || r.type || '-') : (r.type || '-');
    const source    = r.source || 'manual';
    const conf      = r.confirmationCode || r.airbnbRef || '';
    const guest     = r.source === 'airbnb' ? (r.notes || '').split(' · ')[0] : (r.notes || '');
    const eur       = toEUR(dispAmt, r.currency);
    return {
      r, prop, sMeta, isReservation, dispAmt, dispGross,
      propName: prop?.name || '-', typeLabel, source, statusLabel: sMeta.label, conf, guest, eur,
      checkIn:  r.airbnbCheckIn || '',
      checkOut: r.airbnbCheckOut || '',
      nights:   isReservation && r.airbnbNights ? r.airbnbNights : null,
      avgNight: isReservation ? (r.avgNightExclCleaning != null ? r.avgNightExclCleaning : (r.avgNightlyRate != null ? r.avgNightlyRate : null)) : null,
      avgGross: isReservation && r.avgGross != null ? r.avgGross : null,
      searchText: [fmtDate(r.date), prop?.name, typeLabel, source, sMeta.label, conf, guest, r.currency].filter(Boolean).join(' ').toLowerCase()
    };
  };

  // Sort accessors, one per data column (matches the header order below).
  const colAccessors = [
    d => d.r.date, d => d.propName, d => d.typeLabel, d => d.source, d => d.statusLabel,
    d => d.conf, d => d.guest, d => d.eur, d => d.eur, d => (d.dispGross ?? -Infinity),
    d => d.checkIn, d => d.checkOut, d => (d.nights ?? -Infinity),
    d => (d.avgNight ?? -Infinity), d => (d.avgGross ?? -Infinity)
  ];
  const HEADERS = [
    ['Date', ''], ['Property', ''], ['Type', ''], ['Source', ''], ['Status', ''], ['Conf. Code', ''], ['Guest', ''],
    ['Amount', 'right'], ['EUR', 'right'], ['Gross', 'right'], ['Check-in', 'right'], ['Check-out', 'right'],
    ['Nights', 'right'], ['Avg/Night', 'right'], ['Avg Gross/N', 'right']
  ];

  const renderTable = () => {
    selected.clear();
    syncDeleteBtn();
    tableWrap.innerHTML = '';
    pagerWrap.innerHTML = '';

    // 1. Facet filters
    let derived = listActivePayments().filter(r => {
      if (yearFilter.size > 0   && !(r.date && yearFilter.has(r.date.slice(0, 4))))  return false;
      if (monthFilter.size > 0  && !(r.date && monthFilter.has(r.date.slice(5, 7)))) return false;
      if (streamFilter.size > 0 && !streamFilter.has(r.stream || ''))                return false;
      if (propFilter.size > 0   && !propFilter.has(r.propertyId))                    return false;
      if (typeFilter.size > 0   && !typeFilter.has(getPayType(r)))                   return false;
      if (statusFilter.size > 0 && !statusFilter.has(r.status))                      return false;
      return true;
    }).map(derive);

    // 2. Text search (whole dataset)
    if (_allPaySearch) derived = derived.filter(d => d.searchText.includes(_allPaySearch));

    // 3. Sort (date desc by default, otherwise by clicked column)
    if (_allPaySortCol >= 0 && colAccessors[_allPaySortCol]) {
      const acc = colAccessors[_allPaySortCol], dir = _allPaySortDir;
      derived.sort((a, b) => {
        const av = acc(a), bv = acc(b);
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
        return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
      });
    } else {
      derived.sort((a, b) => (b.r.date || '').localeCompare(a.r.date || ''));
    }

    const total = derived.length;
    if (total === 0) {
      tableWrap.appendChild(el('div', { class: 'empty' }, _allPaySearch ? 'No payments match your search' : 'No payments match your filters'));
      return;
    }

    const totalEUR = derived.reduce((s, d) => s + d.eur, 0);

    // 4. Paginate
    const pageCount = Math.max(1, Math.ceil(total / _allPayPageSize));
    if (_allPayPage >= pageCount) _allPayPage = pageCount - 1;
    if (_allPayPage < 0) _allPayPage = 0;
    const startIdx = _allPayPage * _allPayPageSize;
    const pageRows = derived.slice(startIdx, startIdx + _allPayPageSize);

    const t = el('table', { class: 'table' });
    const selectAllChk = el('input', { type: 'checkbox', style: 'cursor:pointer' });
    const htr = el('tr', {});
    const chkTh = el('th', { style: 'width:36px' }); chkTh.appendChild(selectAllChk);
    htr.appendChild(chkTh);
    HEADERS.forEach(([label, cls], i) => {
      const th = el('th', cls ? { class: cls } : {}, label);
      th.style.cursor = 'pointer';
      th.style.userSelect = 'none';
      const arr = el('span', { style: 'margin-left:4px;font-size:10px;opacity:' + (_allPaySortCol === i ? '1' : '0.4') },
        _allPaySortCol === i ? (_allPaySortDir > 0 ? ' ▲' : ' ▼') : ' ⇅');
      th.appendChild(arr);
      th.onclick = () => {
        if (_allPaySortCol === i) _allPaySortDir *= -1; else { _allPaySortCol = i; _allPaySortDir = 1; }
        _allPayPage = 0;
        renderTable();
      };
      htr.appendChild(th);
    });
    htr.appendChild(el('th', {}));
    const thead = el('thead', {}); thead.appendChild(htr); t.appendChild(thead);
    const tb = el('tbody');
    t.appendChild(tb);

    const rowChks = [];

    const buildRow = (d) => {
      const { r, sMeta } = d;
      const chk = el('input', { type: 'checkbox', style: 'cursor:pointer' });
      rowChks.push(chk);
      chk.onchange = () => {
        if (chk.checked) selected.add(r.id); else selected.delete(r.id);
        const n = rowChks.filter(c => c.checked).length;
        selectAllChk.indeterminate = n > 0 && n < pageRows.length;
        selectAllChk.checked = n === pageRows.length;
        syncDeleteBtn();
      };

      const tr = el('tr');
      const chkTd = el('td', { style: 'width:36px' }); chkTd.appendChild(chk);
      tr.appendChild(chkTd);
      tr.appendChild(el('td', {}, fmtDate(r.date)));
      tr.appendChild(el('td', {}, d.propName));
      tr.appendChild(el('td', {}, d.typeLabel));
      tr.appendChild(el('td', {}, el('span', { class: 'badge' }, d.source)));
      tr.appendChild(el('td', {}, el('span', { class: `badge ${sMeta.css}` }, d.statusLabel)));
      tr.appendChild(el('td', { class: 'muted', style: 'font-size:11px' }, d.conf));
      tr.appendChild(el('td', { class: 'muted', style: 'font-size:12px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, d.guest));
      tr.appendChild(el('td', { class: 'right num' }, formatMoney(d.dispAmt, r.currency, { maxFrac: 0 })));
      tr.appendChild(el('td', { class: 'right num muted' }, r.currency === 'EUR' ? '' : formatEUR(d.eur)));
      tr.appendChild(el('td', { class: 'right num muted' }, d.dispGross != null ? formatMoney(d.dispGross, r.currency, { maxFrac: 0 }) : ''));
      tr.appendChild(el('td', { class: 'right muted' }, d.checkIn ? fmtDate(d.checkIn) : ''));
      tr.appendChild(el('td', { class: 'right muted' }, d.checkOut ? fmtDate(d.checkOut) : ''));
      tr.appendChild(el('td', { class: 'right muted' }, d.nights != null ? String(d.nights) : ''));
      tr.appendChild(el('td', { class: 'right num muted' }, d.avgNight != null ? formatMoney(d.avgNight, r.currency, { maxFrac: 0 }) : ''));
      tr.appendChild(el('td', { class: 'right num muted' }, d.avgGross != null ? formatMoney(d.avgGross, r.currency, { maxFrac: 0 }) : ''));
      const actions = el('td', { class: 'right' });
      actions.appendChild(button('Edit', { variant: 'sm ghost', onClick: () => openForm(r) }));
      actions.appendChild(button('Del', { variant: 'sm ghost', onClick: async () => {
        const ok = await confirmDialog('Delete this payment?', { danger: true, okLabel: 'Delete' });
        if (!ok) return;
        const isAirbnbPending = r.source === 'airbnb' && r.status === 'pending';
        const propId = r.propertyId;
        const monthKey = (r.airbnbCheckIn || r.date || '').slice(0, 7);
        removeReservationExpenses(r);
        softDelete('payments', r.id);
        if (isAirbnbPending && propId && monthKey) recalcPendingAirbnbForecast(propId, monthKey);
        toast('Deleted', 'success');
        renderTable();
      }}));
      tr.appendChild(actions);
      return tr;
    };

    const frag = document.createDocumentFragment();
    for (const d of pageRows) frag.appendChild(buildRow(d));
    tb.appendChild(frag);
    tableWrap.appendChild(t);

    selectAllChk.onchange = () => {
      rowChks.forEach(c => { c.checked = selectAllChk.checked; });
      selectAllChk.indeterminate = false;
      if (selectAllChk.checked) pageRows.forEach(d => selected.add(d.r.id)); else selected.clear();
      syncDeleteBtn();
    };

    tableWrap.appendChild(el('div', { class: 'flex justify-between table-footer', style: 'padding:14px 16px;border-top:1px solid var(--border);font-size:13px' },
      el('span', { class: 'muted' }, `${total} payment(s)`),
      el('span', {}, 'Total: ', el('strong', { class: 'num' }, formatEUR(totalEUR)))
    ));

    // Pagination controls
    const endIdx = Math.min(startIdx + _allPayPageSize, total);
    const prevBtn = button('‹ Prev', { variant: 'sm ghost', onClick: () => { if (_allPayPage > 0) { _allPayPage--; renderTable(); } } });
    const nextBtn = button('Next ›', { variant: 'sm ghost', onClick: () => { if (_allPayPage < pageCount - 1) { _allPayPage++; renderTable(); } } });
    prevBtn.disabled = _allPayPage === 0;
    nextBtn.disabled = _allPayPage >= pageCount - 1;
    const sizeSel = select(PAGE_SIZES.map(n => ({ value: String(n), label: `${n} / page` })), String(_allPayPageSize));
    sizeSel.style.maxWidth = '120px';
    sizeSel.onchange = () => { _allPayPageSize = Number(sizeSel.value); _allPayPage = 0; renderTable(); };
    pagerWrap.appendChild(el('span', { class: 'muted', style: 'font-size:13px' }, `Showing ${startIdx + 1}–${endIdx} of ${total}`));
    pagerWrap.appendChild(el('div', { class: 'flex gap-8', style: 'align-items:center;flex-wrap:wrap' },
      sizeSel, prevBtn, el('span', { style: 'font-size:13px' }, `Page ${_allPayPage + 1} / ${pageCount}`), nextBtn
    ));
  };

  rebuildFilters();
  requestAnimationFrame(() => renderTable());
  return () => { rebuildFilters(); renderTable(); };
}

function recordRentPayment(prop, entry, onDone) {
  upsert('payments', {
    id: newId('pay'),
    propertyId: prop.id,
    tenantId: entry.tenantId || null,
    amount: entry.amount,
    currency: entry.currency,
    date: entry.date,
    type: 'rental',
    status: 'paid',
    source: 'manual',
    stream: 'long_term_rental',
    notes: `Rent ${entry.monthKey}`
  });
  toast('Payment recorded', 'success');
  if (onDone) onDone();
}

function buildScheduleSection(wrap) {
  const allLtProps = (listActive('properties')).filter(p => p.type === 'long_term');
  if (allLtProps.length === 0) {
    wrap.appendChild(el('div', { class: 'empty' }, 'No long-term rental properties configured'));
    return;
  }

  const MONTH_LABELS_S = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const SCHED_STATUS = {
    paid:           { label: 'Paid',           css: 'success' },
    overdue:        { label: 'Overdue',         css: 'danger'  },
    'due-this-month': { label: 'Due This Month', css: 'warning' },
    upcoming:       { label: 'Upcoming',        css: ''        }
  };

  const yearFilter   = new Set();
  const monthFilter  = new Set();
  const propFilter   = new Set();
  const statusFilter = new Set();

  let _schedTimer;
  const debouncedRender = () => { clearTimeout(_schedTimer); _schedTimer = setTimeout(render, 150); };

  const yearMS   = buildMultiSelect([], yearFilter,   'All Years',      debouncedRender, 'sched_years');
  const monthMS  = buildMultiSelect([], monthFilter,  'All Months',     debouncedRender, 'sched_months');
  const propMS   = buildMultiSelect([], propFilter,   'All Properties', debouncedRender, 'sched_props');
  const statusMS = buildMultiSelect([], statusFilter, 'All Statuses',   debouncedRender, 'sched_statuses');

  const showUnpaidOnly = el('label', { class: 'flex gap-8', style: 'align-items:center;cursor:pointer;font-size:13px' });
  const unpaidChk = el('input', { type: 'checkbox' });
  showUnpaidOnly.appendChild(unpaidChk);
  showUnpaidOnly.appendChild(document.createTextNode('Unpaid only'));

  const bar = el('div', { class: 'flex gap-8 mb-16', style: 'align-items:center;flex-wrap:wrap' });
  bar.appendChild(yearMS);
  bar.appendChild(monthMS);
  bar.appendChild(propMS);
  bar.appendChild(statusMS);
  bar.appendChild(button('Reset Filters', { variant: 'sm ghost', onClick: () => { yearMS.reset(); monthMS.reset(); propMS.reset(); statusMS.reset(); render(); } }));
  bar.appendChild(el('div', { class: 'flex-1' }));
  bar.appendChild(showUnpaidOnly);
  wrap.appendChild(bar);

  const kpiRow = el('div', { class: 'grid grid-4 mb-16' });
  wrap.appendChild(kpiRow);

  const tableWrap = el('div', { class: 'table-wrap' });
  wrap.appendChild(tableWrap);
  attachSortFilter(tableWrap, { initialCol: _schedSortCol, initialDir: _schedSortDir, onSortChange: (c, d) => { _schedSortCol = c; _schedSortDir = d; } });

  let selected = new Set();

  const syncDeleteBtn = () => {
    if (selected.size > 0) {
      deleteSelBtn.textContent = `Delete ${selected.size} Selected`;
      deleteSelBtn.style.display = 'inline-flex';
    } else {
      deleteSelBtn.style.display = 'none';
    }
  };

  const getSchedStatus = (s, thisMonthKey) =>
    s.paid ? 'paid' : s.overdue ? 'overdue' : s.monthKey === thisMonthKey ? 'due-this-month' : 'upcoming';

  const rebuildSchedFilters = (allEntries, thisMonthKey) => {
    const matchesExceptSched = (e, skip) => {
      const st = getSchedStatus(e, thisMonthKey);
      if (skip !== 'year'   && yearFilter.size   > 0 && !yearFilter.has(e.monthKey.slice(0, 4)))  return false;
      if (skip !== 'month'  && monthFilter.size  > 0 && !monthFilter.has(e.monthKey.slice(5, 7))) return false;
      if (skip !== 'prop'   && propFilter.size   > 0 && !propFilter.has(e.propId))                return false;
      if (skip !== 'status' && statusFilter.size > 0 && !statusFilter.has(st))                    return false;
      return true;
    };
    const ys = new Set(), ms = new Set(), ps = new Set(), ss = new Set();
    for (const e of allEntries) {
      if (matchesExceptSched(e, 'year'))   ys.add(e.monthKey.slice(0, 4));
      if (matchesExceptSched(e, 'month'))  ms.add(e.monthKey.slice(5, 7));
      if (matchesExceptSched(e, 'prop'))   ps.add(e.propId);
      if (matchesExceptSched(e, 'status')) ss.add(getSchedStatus(e, thisMonthKey));
    }
    yearMS.setItems([...ys].sort().reverse().map(y => ({ value: y, label: y })));
    monthMS.setItems([...ms].sort().map(m => ({ value: m, label: MONTH_LABELS_S[parseInt(m, 10) - 1] })));
    propMS.setItems(allLtProps.filter(p => ps.has(p.id)).sort((a, b) => a.name.localeCompare(b.name)).map(p => ({ value: p.id, label: p.name })));
    statusMS.setItems([...ss].sort().map(s => { const m = SCHED_STATUS[s] || { label: s, css: '' }; return { value: s, label: m.label, css: m.css }; }));
  };

  const render = () => {
    selected.clear();
    syncDeleteBtn();

    const now = new Date();
    const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // Collect all schedule entries from all LT properties
    const allEntries = [];
    for (const prop of allLtProps) {
      for (const e of generatePaymentSchedule(prop)) {
        allEntries.push({ ...e, prop, propId: prop.id });
      }
    }

    rebuildSchedFilters(allEntries, thisMonthKey);

    // Apply filters
    let rows = allEntries;
    if (yearFilter.size   > 0) rows = rows.filter(e => yearFilter.has(e.monthKey.slice(0, 4)));
    if (monthFilter.size  > 0) rows = rows.filter(e => monthFilter.has(e.monthKey.slice(5, 7)));
    if (propFilter.size   > 0) rows = rows.filter(e => propFilter.has(e.propId));
    if (statusFilter.size > 0) rows = rows.filter(e => statusFilter.has(getSchedStatus(e, thisMonthKey)));
    if (unpaidChk.checked) rows = rows.filter(s => !s.paid);
    rows.sort((a, b) => a.date.localeCompare(b.date));

    // KPI cards computed from ALL entries (not filtered) for accurate global view
    const paidThisYear = allEntries.filter(e => e.paid && e.monthKey.startsWith(String(now.getFullYear())));
    const overdueAll   = allEntries.filter(e => e.overdue);
    const upcomingAll  = allEntries.filter(e => !e.paid && !e.overdue);
    const next         = [...upcomingAll].sort((a, b) => a.date.localeCompare(b.date))[0];
    const daysToNext   = next ? Math.ceil((new Date(next.date) - now) / 86400000) : null;

    const tenants = listActive('tenants');
    const toRows = entries => entries.map(e => {
      const t = tenants.find(t => t.id === e.tenantId);
      return {
        property: e.prop.name,
        tenant: t ? t.name : (e.prop.tenantName || e.prop.name),
        dueDate: e.date,
        amount: e.amount,
        currency: e.currency,
        status: e.paid ? 'paid' : e.overdue ? 'overdue' : 'upcoming'
      };
    });
    const schedCols = [
      { key: 'property', label: 'Property' },
      { key: 'tenant', label: 'Tenant' },
      { key: 'dueDate', label: 'Due Date', format: v => fmtDate(v) },
      { key: 'amount', label: 'Amount', right: true, format: (v, row) => formatMoney(v, row.currency, { maxFrac: 0 }) },
      { key: 'status', label: 'Status', format: v => ({ paid: el('span', { class: 'badge success' }, 'Paid'), overdue: el('span', { class: 'badge danger' }, 'Overdue'), upcoming: el('span', { class: 'badge' }, 'Upcoming') })[v] || el('span', { class: 'badge' }, v) }
    ];

    kpiRow.innerHTML = '';
    kpiRow.appendChild(kpiCard('Paid This Year', String(paidThisYear.length), formatEUR(paidThisYear.reduce((s, e) => s + e.amountEUR, 0)), 'success',
      paidThisYear.length ? () => drillDownModal('Paid This Year', toRows(paidThisYear), schedCols) : null));
    kpiRow.appendChild(kpiCard('Overdue', String(overdueAll.length), overdueAll.length ? formatEUR(overdueAll.reduce((s, e) => s + e.amountEUR, 0)) : '—', overdueAll.length ? 'danger' : '',
      overdueAll.length ? () => drillDownModal('Overdue Payments', toRows(overdueAll), schedCols) : null));
    kpiRow.appendChild(kpiCard('Upcoming', String(upcomingAll.length), upcomingAll.length ? formatEUR(upcomingAll.reduce((s, e) => s + e.amountEUR, 0)) : '—', '',
      upcomingAll.length ? () => drillDownModal('Upcoming Payments', toRows(upcomingAll), schedCols) : null));
    kpiRow.appendChild(kpiCard('Next Due', next ? fmtDate(next.date) : '—', daysToNext !== null ? (daysToNext <= 0 ? 'Today!' : daysToNext === 1 ? 'Tomorrow' : `In ${daysToNext} days`) : '—', daysToNext !== null && daysToNext <= 3 ? 'warning' : '',
      next ? () => drillDownModal('Next Due', toRows([next]), schedCols) : null));

    tableWrap.innerHTML = '';
    if (rows.length === 0) { tableWrap.appendChild(el('div', { class: 'empty' }, 'No entries match your filters')); return; }

    const t = el('table', { class: 'table' });
    const hasSelectable = rows.some(s => !!s.linkedPaymentId);
    const selectAllChk = el('input', { type: 'checkbox', style: 'cursor:pointer' });
    const htr = el('tr');
    const chkTh = el('th', { style: 'width:36px' });
    if (hasSelectable) chkTh.appendChild(selectAllChk);
    htr.appendChild(chkTh);
    [['Property', ''], ['Tenant', ''], ['Due Date', ''], ['Month', ''], ['Amount', 'right'], ['Cur.', ''], ['Status', ''], ['', '']].forEach(([h, cls]) => {
      htr.appendChild(el('th', cls ? { class: cls } : {}, h));
    });
    const thead = el('thead'); thead.appendChild(htr); t.appendChild(thead);
    const tb = el('tbody');

    for (const s of rows) {
      const { prop } = s;
      const isThisMonth = s.monthKey === thisMonthKey;
      const tr = el('tr');

      const closeOtherEdits = () => {
        tb.querySelectorAll('tr.row-editing').forEach(r => r.dispatchEvent(new CustomEvent('cancel-edit')));
      };

      const renderViewRow = () => {
        tr.innerHTML = '';
        tr.classList.remove('row-editing');
        tr.style.background = isThisMonth && !s.paid ? 'rgba(99,102,241,0.04)' : '';

        const chkTd = el('td', { style: 'width:36px' });
        if (s.linkedPaymentId) {
          const chk = el('input', { type: 'checkbox', style: 'cursor:pointer' });
          chk.checked = selected.has(s.linkedPaymentId);
          chk.onchange = () => {
            if (chk.checked) selected.add(s.linkedPaymentId); else selected.delete(s.linkedPaymentId);
            const allChks = [...tb.querySelectorAll('input[type="checkbox"]')];
            const n = allChks.filter(c => c.checked).length;
            selectAllChk.indeterminate = n > 0 && n < allChks.length;
            selectAllChk.checked = allChks.length > 0 && n === allChks.length;
            syncDeleteBtn();
          };
          chkTd.appendChild(chk);
        }
        tr.appendChild(chkTd);
        tr.appendChild(el('td', { class: 'muted', style: 'font-size:12px' }, prop.name));
        const tenantObj = s.tenantId ? tenants.find(t => t.id === s.tenantId) : null;
        tr.appendChild(el('td', { class: 'muted', style: 'font-size:12px' }, tenantObj?.name || prop.tenantName || '—'));
        tr.appendChild(el('td', {}, fmtDate(s.date)));
        tr.appendChild(el('td', { class: 'muted' }, s.monthKey));
        tr.appendChild(el('td', { class: 'right num' }, formatMoney(s.amount, s.currency, { maxFrac: 0 })));
        tr.appendChild(el('td', { class: 'muted', style: 'font-size:12px' }, s.currency));
        tr.appendChild(el('td', {},
          s.paid ? el('span', { class: 'badge success' }, 'Paid')
          : s.overdue ? el('span', { class: 'badge danger' }, 'Overdue')
          : isThisMonth ? el('span', { class: 'badge warning' }, 'Due this month')
          : el('span', { class: 'badge' }, 'Upcoming')
        ));
        const td = el('td', { class: 'right', style: 'white-space:nowrap' });
        if (!s.paid) {
          td.appendChild(button('Mark Paid', { variant: 'sm primary', onClick: () => recordRentPayment(prop, s, render) }));
        }
        td.appendChild(button('Edit', { variant: 'sm ghost', onClick: () => { closeOtherEdits(); renderEditRow(); } }));
        if (s.linkedPaymentId) {
          td.appendChild(button('Delete', { variant: 'sm danger', onClick: async () => {
            const ok = await confirmDialog('Delete this payment record? This cannot be undone.', { danger: true, okLabel: 'Delete' });
            if (!ok) return;
            deletePayment(s.linkedPaymentId);
            toast('Payment record deleted', 'success');
            render();
          }}));
        }
        tr.appendChild(td);
      };

      const renderEditRow = () => {
        tr.innerHTML = '';
        tr.classList.add('row-editing');
        tr.style.background = '';

        tr.appendChild(el('td', {})); // checkbox placeholder
        tr.appendChild(el('td', { class: 'muted', style: 'font-size:12px' }, prop.name)); // property read-only
        tr.appendChild(el('td', {})); // tenant placeholder

        const linked = s.linkedPaymentId ? byId('payments', s.linkedPaymentId) || null : null;

        const dateI = el('input', { type: 'date', class: 'input', value: linked?.date || s.date, style: 'min-width:130px;width:100%' });
        const amtI  = el('input', { type: 'number', class: 'input', value: String(linked?.amount ?? s.amount), min: '0', step: '0.01', style: 'min-width:80px;width:100%' });
        const curS  = el('select', { class: 'select', style: 'width:100%' });
        for (const c of CURRENCIES) {
          const o = el('option', { value: c }, c);
          if (c === (linked?.currency || s.currency)) o.selected = true;
          curS.appendChild(o);
        }

        const statusOpts = [{ value: 'paid', label: 'Paid' }, { value: 'pending', label: 'Pending' }];
        if (s.linkedPaymentId) statusOpts.push({ value: 'revert', label: 'Revert to Scheduled' });
        const currentStatus = linked?.status === 'paid' ? 'paid' : 'pending';
        const statusS = el('select', { class: 'select', style: 'width:100%' });
        for (const o of statusOpts) {
          const opt = el('option', { value: o.value }, o.label);
          if (o.value === currentStatus) opt.selected = true;
          statusS.appendChild(opt);
        }

        const notesI = el('input', { type: 'text', class: 'input', value: linked?.notes || `Rent ${s.monthKey}`, placeholder: 'Notes', style: 'width:100%;margin-bottom:6px' });

        tr.addEventListener('cancel-edit', renderViewRow);

        const saveBtn = button('Save', { variant: 'sm primary', onClick: () => {
          const newDate  = dateI.value, newAmt = Number(amtI.value), newCur = curS.value;
          const newStat  = statusS.value, newNotes = notesI.value.trim() || `Rent ${s.monthKey}`;
          if (!newDate) { toast('Date is required', 'danger'); return; }
          if (newAmt <= 0) { toast('Amount must be greater than zero', 'danger'); return; }
          if (newStat === 'revert') {
            if (s.linkedPaymentId) deletePayment(s.linkedPaymentId);
            toast('Payment record removed — row reverted to scheduled state', 'success');
          } else {
            const pay = linked ? { ...linked } : {
              id: newId('pay'), propertyId: prop.id, tenantId: s.tenantId || null,
              stream: 'long_term_rental', source: 'manual', type: 'rental'
            };
            Object.assign(pay, { amount: newAmt, currency: newCur, date: newDate, status: newStat, notes: newNotes });
            upsert('payments', pay);
            toast(`Payment ${linked ? 'updated' : 'recorded'} as ${newStat}`, 'success');
          }
          render();
        }});

        const cancelBtn = button('Cancel', { variant: 'sm ghost', onClick: renderViewRow });
        tr.appendChild(el('td', {}, dateI));
        tr.appendChild(el('td', { class: 'muted', style: 'font-size:11px;white-space:nowrap' }, s.monthKey));
        tr.appendChild(el('td', {}, amtI));
        tr.appendChild(el('td', {}, curS));
        tr.appendChild(el('td', {}, statusS));
        const lastTd = el('td', {});
        lastTd.appendChild(notesI);
        const btnRow = el('div', { class: 'flex gap-4', style: 'justify-content:flex-end' });
        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(saveBtn);
        lastTd.appendChild(btnRow);
        tr.appendChild(lastTd);
      };

      renderViewRow();
      tb.appendChild(tr);
    }

    t.appendChild(tb);
    tableWrap.appendChild(t);

    if (hasSelectable) {
      selectAllChk.onchange = () => {
        const allChks = [...tb.querySelectorAll('input[type="checkbox"]')];
        allChks.forEach(c => { c.checked = selectAllChk.checked; });
        selectAllChk.indeterminate = false;
        if (selectAllChk.checked) {
          for (const s of rows) { if (s.linkedPaymentId) selected.add(s.linkedPaymentId); }
        } else {
          selected.clear();
        }
        syncDeleteBtn();
      };
    }

    const totalEUR = rows.reduce((s, e) => s + e.amountEUR, 0);
    tableWrap.appendChild(el('div', { class: 'flex justify-between', style: 'padding:14px 16px;border-top:1px solid var(--border);font-size:13px' },
      el('span', { class: 'muted' }, `${rows.length} month(s) shown`),
      el('strong', { class: 'num' }, `Total: ${formatEUR(totalEUR)}`)
    ));
  };

  const deleteSelBtn = button('', { variant: 'danger', onClick: async () => {
    const count = selected.size;
    if (!count) return;
    const ok = await confirmDialog(`Delete ${count} payment record(s)? This cannot be undone.`, { danger: true, okLabel: `Delete ${count}` });
    if (!ok) return;
    for (const id of [...selected]) deletePayment(id);
    selected.clear();
    toast(`Deleted ${count} payment record(s)`, 'success');
    render();
  }});
  deleteSelBtn.style.display = 'none';
  bar.insertBefore(deleteSelBtn, yearMS);

  unpaidChk.onchange = render;
  render();
  return render;
}

function kpiCard(label, value, sub, variant, onClick) {
  const card = el('div', { class: `kpi${variant ? ' ' + variant : ''}` },
    el('div', { class: 'kpi-label' }, label),
    el('div', { class: 'kpi-value num' }, value),
    sub ? el('div', { class: 'fx-hint' }, sub) : null
  );
  if (onClick) { card.onclick = onClick; card.style.cursor = 'pointer'; }
  return card;
}

function buildUpcomingSection(wrap) {
  const tenantPropIds = new Set((listActive('tenants')).filter(t => t.monthlyRent).map(t => t.propertyId));
  const ltProps = (listActive('properties')).filter(p => p.type === 'long_term' && tenantPropIds.has(p.id));
  if (ltProps.length === 0) {
    wrap.appendChild(el('div', { class: 'empty' }, 'No long-term rental properties configured'));
    return;
  }

  const horizonSel = select([
    { value: '1', label: 'Next 1 month' },
    { value: '3', label: 'Next 3 months' },
    { value: '6', label: 'Next 6 months' },
    { value: '12', label: 'Next 12 months' }
  ], '3');
  const bar = el('div', { class: 'flex gap-8 mb-16', style: 'align-items:center' });
  bar.appendChild(el('span', { style: 'font-size:13px;color:var(--text-muted)' }, 'Show:'));
  bar.appendChild(horizonSel);
  wrap.appendChild(bar);

  const kpiRow = el('div', { class: 'grid grid-4 mb-16' });
  wrap.appendChild(kpiRow);

  const tableWrap = el('div', { class: 'table-wrap' });
  wrap.appendChild(tableWrap);
  attachSortFilter(tableWrap, { initialCol: _upcomSortCol, initialDir: _upcomSortDir, onSortChange: (c, d) => { _upcomSortCol = c; _upcomSortDir = d; } });

  const render = () => {
    const now = new Date();
    const horizonMonths = Number(horizonSel.value);
    const cutoff = new Date(now.getFullYear(), now.getMonth() + horizonMonths + 1, 1);
    const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // Collect all overdue + upcoming within horizon across all LT properties
    const allEntries = [];
    for (const prop of ltProps) {
      for (const entry of generatePaymentSchedule(prop)) {
        if (entry.paid) continue;
        if (!entry.overdue && new Date(entry.date) >= cutoff) continue;
        allEntries.push({ ...entry, prop });
      }
    }
    allEntries.sort((a, b) => a.date.localeCompare(b.date));

    const overdue = allEntries.filter(e => e.overdue);
    const thisMonth = allEntries.filter(e => e.monthKey === thisMonthKey);
    const upcoming = allEntries.filter(e => !e.overdue);
    const totalEUR = allEntries.reduce((s, e) => s + e.amountEUR, 0);

    const toRows = entries => entries.map(e => ({
      property: e.prop.name,
      tenant: e.tenantId ? (byId('tenants', e.tenantId)?.name || e.prop.tenantName || '—') : (e.prop.tenantName || '—'),
      dueDate: e.date,
      amount: e.amount,
      currency: e.currency,
      status: e.overdue ? 'overdue' : e.monthKey === thisMonthKey ? 'due-this-month' : 'upcoming'
    }));
    const upcomingCols = [
      { key: 'property', label: 'Property' },
      { key: 'tenant', label: 'Tenant' },
      { key: 'dueDate', label: 'Due Date', format: v => fmtDate(v) },
      { key: 'amount', label: 'Amount', right: true, format: (v, row) => formatMoney(v, row.currency, { maxFrac: 0 }) },
      { key: 'status', label: 'Status', format: v => ({ overdue: el('span', { class: 'badge danger' }, 'Overdue'), 'due-this-month': el('span', { class: 'badge warning' }, 'Due this month'), upcoming: el('span', { class: 'badge' }, 'Upcoming') })[v] || el('span', { class: 'badge' }, v) }
    ];

    kpiRow.innerHTML = '';
    kpiRow.appendChild(kpiCard('Overdue', String(overdue.length), overdue.length ? formatEUR(overdue.reduce((s, e) => s + e.amountEUR, 0)) : '—', overdue.length ? 'danger' : '',
      overdue.length ? () => drillDownModal('Overdue', toRows(overdue), upcomingCols) : null));
    kpiRow.appendChild(kpiCard('Due This Month', String(thisMonth.length), thisMonth.length ? formatEUR(thisMonth.reduce((s, e) => s + e.amountEUR, 0)) : '—', thisMonth.length ? 'warning' : '',
      thisMonth.length ? () => drillDownModal('Due This Month', toRows(thisMonth), upcomingCols) : null));
    kpiRow.appendChild(kpiCard('Upcoming', String(upcoming.length), upcoming.length ? formatEUR(upcoming.reduce((s, e) => s + e.amountEUR, 0)) : '—', '',
      upcoming.length ? () => drillDownModal('Upcoming Payments', toRows(upcoming), upcomingCols) : null));
    kpiRow.appendChild(kpiCard('Total Expected', formatEUR(totalEUR), `${allEntries.length} payment(s)`, '',
      allEntries.length ? () => drillDownModal('Total Expected', toRows(allEntries), upcomingCols) : null));

    tableWrap.innerHTML = '';
    if (allEntries.length === 0) {
      tableWrap.appendChild(el('div', { class: 'empty' }, 'No upcoming payments'));
      return;
    }

    const t = el('table', { class: 'table' });
    t.innerHTML = `<thead><tr><th>Due Date</th><th>Property</th><th>Tenant</th><th class="right">Amount</th><th class="right">EUR</th><th>Status</th><th></th></tr></thead>`;
    const tb = el('tbody');
    for (const entry of allEntries) {
      const { prop } = entry;
      const dueDate = new Date(entry.date);
      const diffDays = Math.ceil((dueDate - now) / 86400000);
      const isThisMonth = entry.monthKey === thisMonthKey;

      const statusBadge = entry.overdue
        ? el('span', { class: 'badge danger' }, 'Overdue')
        : isThisMonth
          ? el('span', { class: 'badge warning' }, 'Due this month')
          : el('span', { class: 'badge' }, diffDays <= 7 ? `In ${diffDays}d` : 'Upcoming');

      const tr = el('tr', entry.overdue ? { style: 'background:rgba(239,68,68,.04)' } : {});
      tr.appendChild(el('td', {}, fmtDate(entry.date)));
      tr.appendChild(el('td', {}, prop.name));
      const entryTenant = entry.tenantId ? byId('tenants', entry.tenantId) : null;
      tr.appendChild(el('td', { class: 'muted' }, entryTenant?.name || prop.tenantName || '—'));
      tr.appendChild(el('td', { class: 'right num' }, formatMoney(entry.amount, entry.currency, { maxFrac: 0 })));
      tr.appendChild(el('td', { class: 'right num muted' }, entry.currency === 'EUR' ? '' : formatEUR(entry.amountEUR)));
      tr.appendChild(el('td', {}, statusBadge));
      const td = el('td', { class: 'right' });
      td.appendChild(button('Mark Paid', { variant: 'sm primary', onClick: () => recordRentPayment(prop, entry, render) }));
      tr.appendChild(td);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    tableWrap.appendChild(t);

    tableWrap.appendChild(el('div', { class: 'flex justify-between', style: 'padding:14px 16px;border-top:1px solid var(--border);font-size:13px' },
      el('span', { class: 'muted' }, `${ltProps.length} propert${ltProps.length === 1 ? 'y' : 'ies'} · ${allEntries.length} payment(s)`),
      el('strong', { class: 'num' }, `Expected: ${formatEUR(totalEUR)}`)
    ));
  };

  horizonSel.onchange = render;
  render();
  return render;
}

function openForm(existing) {
  const r = existing ? { ...existing } : {
    id: newId('pay'), propertyId: state.db.properties?.[0]?.id || '',
    amount: 0, currency: 'EUR', date: today(), type: 'off_platform_reservation',
    status: 'paid', source: 'manual', stream: 'short_term_rental', notes: '',
    checkIn: '', checkOut: ''
  };
  const body = el('div', {});
  const propS = select((listActive('properties')).map(p => ({ value: p.id, label: p.name })), r.propertyId);
  const amountI = input({ type: 'number', value: r.amount, min: 0, step: 0.01 });
  const currencyS = select(CURRENCIES, r.currency);
  const dateI = input({ type: 'date', value: r.date });
  const checkInI = input({ type: 'date', value: r.checkIn || '' });
  const checkOutI = input({ type: 'date', value: r.checkOut || '' });
  const statusS = select(Object.keys(PAYMENT_STATUSES), r.status);
  const sourceS = select(['manual', 'airbnb'], r.source);
  const notesT = textarea(); notesT.value = r.notes || '';

  body.appendChild(formRow('Property', propS));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Amount', amountI), formRow('Currency', currencyS)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Date', dateI)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Check-in Date', checkInI), formRow('Check-out Date', checkOutI)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Status', statusS), formRow('Source', sourceS)));
  body.appendChild(formRow('Notes', notesT));

  propS.onchange = () => {
    const p = byId('properties', propS.value);
    if (p) { currencyS.value = p.currency; }
  };

  const save = button('Save', { variant: 'primary', onClick: async () => {
    if (!propS.value) { toast('Select a property', 'danger'); return; }
    if (Number(amountI.value) <= 0) { toast('Amount must be positive', 'danger'); return; }
    if (!existing) {
      const dupe = listActivePayments().find(p =>
        p.propertyId === propS.value && p.date === dateI.value &&
        Number(p.amount) === Number(amountI.value)
      );
      if (dupe) {
        const ok = await confirmDialog(
          `A ${dupe.status} payment of ${formatMoney(dupe.amount, dupe.currency)} already exists for this property on ${fmtDate(dupe.date)}. Save anyway?`,
          { okLabel: 'Save Anyway' }
        );
        if (!ok) return;
      }
    }
    Object.assign(r, {
      propertyId: propS.value, amount: Number(amountI.value),
      currency: currencyS.value, date: dateI.value, type: 'off_platform_reservation',
      status: statusS.value, source: sourceS.value, stream: 'short_term_rental',
      notes: notesT.value.trim(), checkIn: checkInI.value, checkOut: checkOutI.value
    });
    upsert('payments', r);
    if (r.stream === 'short_term_rental') applyReservationExpenseRules(r);
    toast(existing ? 'Payment updated' : 'Payment added', 'success');
    closeModal();
    setTimeout(() => navigate('payments'), 200);
  }});
  openModal({ title: existing ? 'Edit Payment' : 'New Payment', body, footer: [button('Cancel', { onClick: closeModal }), save] });
}

// ===== Airbnb CSV Import =====
function openCSVImport() {
  const props = listActive('properties');
  if (props.length === 0) { toast('Add properties first', 'warning'); return; }

  const stProps = props.filter(p => p.type === 'short_term');
  const normName = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const findProp = listing => {
    const n = normName(listing);
    if (!n) return null;
    return stProps.find(p => normName(p.name) === n)
      || stProps.find(p => n.includes(normName(p.name)) || normName(p.name).includes(n))
      || null;
  };

  const body = el('div', {});

  const makeFileSlot = (label, hint) => {
    const fileI = el('input', { type: 'file', accept: '.csv', class: 'input' });
    const wrap = el('div', { class: 'card', style: 'padding:12px 16px;margin-bottom:12px' },
      el('div', { style: 'font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text-muted);margin-bottom:2px' }, label),
      el('div', { style: 'font-size:11px;color:var(--text-muted);margin-bottom:8px' }, hint),
      fileI
    );
    return { fileI, wrap };
  };

  const { fileI: completedFileI, wrap: completedWrap } = makeFileSlot(
    'Completed Payouts',
    'airbnb_.csv — historical paid-out transactions (overwrites/syncs existing records)'
  );
  const { fileI: pendingFileI, wrap: pendingWrap } = makeFileSlot(
    'Future / Pending Payouts',
    'airbnb_pending.csv — upcoming reservations (adds new only, updates forecast)'
  );

  const preview = el('div', { style: 'font-size:13px;min-height:24px' });

  body.appendChild(completedWrap);
  body.appendChild(pendingWrap);
  body.appendChild(preview);

  const updatePreview = async () => {
    preview.innerHTML = '';

    const completedFile = completedFileI.files?.[0];
    if (completedFile) {
      const text = await completedFile.text();
      const rows = mergeReservationRows(parseAirbnbCSV(text));
      let added = 0, updated = 0, skipped = 0;
      const csvKeys = new Set(rows.map(r => r.airbnbKey).filter(Boolean));
      const allPays = listActivePayments();
      const existingKeySet = new Set(allPays.filter(p => p.airbnbKey).map(p => p.airbnbKey));
      const toDelete = allPays.filter(p => p.source === 'airbnb' && p.airbnbKey && !csvKeys.has(p.airbnbKey)).length;
      for (const row of rows) {
        const pmatch = findProp(row.listing);
        if (!pmatch) { skipped++; continue; }
        const exists = row.airbnbKey ? existingKeySet.has(row.airbnbKey) : false;
        if (exists) updated++; else added++;
      }
      const badge = el('span', { class: 'badge success' }, 'Paid');
      preview.appendChild(el('div', { class: 'flex gap-8', style: 'align-items:center;margin-bottom:6px' },
        badge,
        el('span', { style: 'font-weight:500' }, completedFile.name),
        el('span', { class: 'muted' }, `— ${rows.length} rows · ${added} new · ${updated} update${skipped ? ` · ${skipped} skipped` : ''}${toDelete ? ` · ${toDelete} to remove` : ''}`)
      ));
    }

    const pendingFile = pendingFileI.files?.[0];
    if (pendingFile) {
      const text = await pendingFile.text();
      const rows = parseAirbnbCSV(text);
      const allPays = listActivePayments();
      const existingKeySet = new Set(allPays.filter(p => p.airbnbKey).map(p => p.airbnbKey));
      const paidCodeSet = new Set(allPays.filter(p => p.status === 'paid' && p.confirmationCode).map(p => p.confirmationCode));
      let added = 0, skipped = 0, willMaterialize = 0;
      for (const row of rows) {
        const pmatch = findProp(row.listing);
        if (!pmatch) { skipped++; continue; }
        if (row.confirmationCode && paidCodeSet.has(row.confirmationCode)) { willMaterialize++; continue; }
        const exists = row.airbnbKey ? existingKeySet.has(row.airbnbKey) : false;
        if (!exists) added++;
      }
      const badge = el('span', { class: 'badge warning' }, 'Pending');
      const matText = willMaterialize ? ` · ${willMaterialize} already paid → materialized` : '';
      preview.appendChild(el('div', { class: 'flex gap-8', style: 'align-items:center;margin-bottom:6px' },
        badge,
        el('span', { style: 'font-weight:500' }, pendingFile.name),
        el('span', { class: 'muted' }, `— ${rows.length} rows · ${added} new · forecast updated${skipped ? ` · ${skipped} skipped` : ''}${matText}`)
      ));
    }
  };

  completedFileI.onchange = updatePreview;
  pendingFileI.onchange = updatePreview;

  const importBtn = button('Import', { variant: 'primary', onClick: async () => {
    if (!completedFileI.files?.[0] && !pendingFileI.files?.[0]) {
      toast('Select at least one file', 'warning'); return;
    }

    let totalAdded = 0, totalUpdated = 0, totalRemoved = 0;

    // Batch all the per-row mutations into a single save/refresh cycle instead
    // of one per upsert (thousands during a large import).
    await runBatch(async () => {
    // ── Completed CSV (airbnb_.csv): full sync / overwrite ──────────────────
    const completedFile = completedFileI.files?.[0];
    if (completedFile) {
      const text = await completedFile.text();
      const rows = mergeReservationRows(parseAirbnbCSV(text));

      // Collect keys and confirmation codes present in the CSV
      const csvKeys = new Set(rows.map(r => r.airbnbKey).filter(Boolean));
      const csvReservationCodes = new Set(
        rows.filter(r => r.type.toLowerCase() === 'reservation').map(r => r.confirmationCode).filter(Boolean)
      );

      // Remove orphaned completed payments (airbnbKey set but not in CSV).
      // Never delete pending payments — they come from a separate CSV and aren't
      // in the completed export until after payout.
      // Pre-index generated expenses by reservationRef so each removal is O(1)
      // instead of scanning all expenses per orphaned payment.
      const orphanRefMap = buildReservationExpenseRefMap();
      for (const p of listActivePayments()) {
        if (p.source === 'airbnb' && p.status !== 'pending' && p.airbnbKey && !csvKeys.has(p.airbnbKey)) {
          removeReservationExpenses(p, orphanRefMap);
          softDelete('payments', p.id);
          totalRemoved++;
        }
      }

      const byAirbnbKey = new Map(
        listActivePayments().filter(p => p.airbnbKey).map(p => [p.airbnbKey, p])
      );
      const pendingByCode = new Map();
      for (const p of listActivePayments()) {
        if (p.source === 'airbnb' && p.status === 'pending') {
          if (p.confirmationCode) pendingByCode.set(p.confirmationCode, p);
          if (p.airbnbRef && p.airbnbRef !== p.confirmationCode) pendingByCode.set(p.airbnbRef, p);
        }
      }
      // Index existing generated expenses once so rule application can find an
      // already-generated expense in O(1) (otherwise O(rows × rules × expenses)).
      const genIndex = buildGeneratedExpenseIndex();

      // Upsert each row as a separate payment line item (one per type per code)
      for (const row of rows) {
        const matched = findProp(row.listing);
        if (!matched) continue;

        const existing = row.airbnbKey ? (byAirbnbKey.get(row.airbnbKey) ?? null) : null;
        const pay = existing ? { ...existing } : {
          id: newId('pay'),
          propertyId: matched.id,
          stream: 'short_term_rental',
          source: 'airbnb'
        };
        Object.assign(pay, {
          amount: row.amount,
          currency: row.currency || matched.currency,
          date: row.date,
          type: 'rental',
          status: 'paid',
          airbnbKey: row.airbnbKey,
          confirmationCode: row.confirmationCode,
          airbnbRef: row.confirmationCode,
          airbnbType: row.type,
          airbnbBookingDate: row.bookingDate,
          airbnbCheckIn: row.checkIn,
          airbnbCheckOut: row.checkOut,
          airbnbNights: row.nights,
          airbnbServiceFee: row.serviceFee,
          airbnbCleaningFee: row.cleaningFee,
          airbnbGrossEarnings: row.grossEarnings,
          avgGross: row.avgGross,
          avgNightlyRate: row.avgNightExclCleaning,
          avgNightInclCleaning: row.avgNightInclCleaning,
          avgNightExclCleaning: row.avgNightExclCleaning,
          notes: [row.guest, row.listing].filter(Boolean).join(' · ')
        });
        upsert('payments', pay);
        if (existing) totalUpdated++; else totalAdded++;

        if (row.type.toLowerCase() === 'reservation') applyReservationExpenseRules(pay, genIndex);

        // Materialize any matching pending reservation so it no longer counts
        // in active forecast calculations while remaining visible for history.
        if (row.confirmationCode) {
          const pending = row.confirmationCode ? (pendingByCode.get(row.confirmationCode) ?? null) : null;
          if (pending) {
            const pendingMonthKey = (pending.airbnbCheckIn || pending.date || '').slice(0, 7);
            upsert('payments', {
              ...pending,
              status: 'materialized',
              materializedPaymentId: pay.id,
              materializedAt: new Date().toISOString().slice(0, 10)
            });
            if (pending.confirmationCode) pendingByCode.delete(pending.confirmationCode);
            if (pending.airbnbRef) pendingByCode.delete(pending.airbnbRef);
            if (pending.propertyId && pendingMonthKey) {
              recalcPendingAirbnbForecast(pending.propertyId, pendingMonthKey);
            }
          }
        }
      }
    }

    // ── Pending CSV (airbnb_pending.csv): upsert + always sync forecast ────
    const pendingFile = pendingFileI.files?.[0];
    if (pendingFile) {
      const text = await pendingFile.text();
      const rows = parseAirbnbCSV(text);

      // Accumulate totals per (property, month) so we can set the forecast in
      // one pass — prevents double-counting when the same CSV is re-imported.
      const forecastMap = new Map(); // "propertyId|monthKey" → { year, propertyId, monthKey, total }

      const byAirbnbKeyP = new Map(
        listActivePayments().filter(p => p.airbnbKey).map(p => [p.airbnbKey, p])
      );
      const pendingByRefP = new Map(
        listActivePayments()
          .filter(p => p.source === 'airbnb' && p.status === 'pending' && p.airbnbRef)
          .map(p => [p.airbnbRef, p])
      );
      const paidByCodeP = new Map(
        listActivePayments()
          .filter(p => p.status === 'paid' && p.confirmationCode)
          .map(p => [p.confirmationCode, p])
      );
      const genIndexP = buildGeneratedExpenseIndex();

      for (const row of rows) {
        const matched = findProp(row.listing);
        if (!matched) continue;

        // Dedup: prefer airbnbKey match; fall back to confirmationCode (airbnbRef)
        // for payments imported before the airbnbKey field was introduced.
        const existingByKey = row.airbnbKey ? (byAirbnbKeyP.get(row.airbnbKey) ?? null) : null;
        const existingByRef = !existingByKey && row.confirmationCode ? (pendingByRefP.get(row.confirmationCode) ?? null) : null;
        const existing = existingByKey || existingByRef;

        // If a paid payment already exists for this confirmation code, record as materialized
        // (mirrors the completed-CSV logic that materializes a pending when its paid counterpart arrives)
        const paidMatch = !existing && row.confirmationCode ? (paidByCodeP.get(row.confirmationCode) ?? null) : null;
        if (paidMatch) {
          upsert('payments', {
            id: newId('pay'), propertyId: matched.id, stream: 'short_term_rental', source: 'airbnb',
            amount: row.amount, currency: row.currency || matched.currency, date: row.date,
            type: 'rental', status: 'materialized',
            airbnbKey: row.airbnbKey, confirmationCode: row.confirmationCode, airbnbRef: row.confirmationCode,
            airbnbType: row.type, airbnbCheckIn: row.checkIn, airbnbCheckOut: row.checkOut,
            airbnbNights: row.nights, airbnbGrossEarnings: row.grossEarnings,
            notes: [row.guest, row.listing].filter(Boolean).join(' · '),
            materializedPaymentId: paidMatch.id, materializedAt: new Date().toISOString().slice(0, 10)
          });
          totalAdded++;
          continue;
        }

        const payFields = {
          amount: row.amount,
          currency: row.currency || matched.currency,
          date: row.date,
          type: 'rental',
          status: 'pending',
          airbnbKey: row.airbnbKey,
          confirmationCode: row.confirmationCode,
          airbnbRef: row.confirmationCode,
          airbnbType: row.type,
          airbnbBookingDate: row.bookingDate,
          airbnbCheckIn: row.checkIn,
          airbnbCheckOut: row.checkOut,
          airbnbNights: row.nights,
          airbnbServiceFee: row.serviceFee,
          airbnbCleaningFee: row.cleaningFee,
          airbnbGrossEarnings: row.grossEarnings,
          avgGross: row.avgGross,
          avgNightlyRate: row.avgNightExclCleaning,
          avgNightInclCleaning: row.avgNightInclCleaning,
          avgNightExclCleaning: row.avgNightExclCleaning,
          notes: [row.guest, row.listing].filter(Boolean).join(' · ')
        };

        let pay;
        if (existing) {
          // Migrate old-format records (no airbnbKey) to new format
          Object.assign(existing, payFields);
          pay = existing;
          totalUpdated++;
        } else {
          pay = { id: newId('pay'), propertyId: matched.id, stream: 'short_term_rental', source: 'airbnb', ...payFields };
          totalAdded++;
        }
        upsert('payments', pay);

        if (row.type?.toLowerCase() === 'reservation') applyReservationExpenseRules(pay, genIndexP);

        // Accumulate forecast total for this property+month
        const refDate = row.checkIn || row.date;
        if (refDate && matched.id) {
          const year = refDate.slice(0, 4);
          const monthKey = `${year}-${refDate.slice(5, 7)}`;
          const fKey = `${matched.id}|${monthKey}`;
          if (!forecastMap.has(fKey)) {
            forecastMap.set(fKey, { year, propertyId: matched.id, monthKey, total: 0 });
          }
          forecastMap.get(fKey).total += toEUR(row.amount, row.currency, refDate);
        }
      }

      // Write forecast once per (property, month) — set rather than accumulate
      // so re-importing the same CSV never double-counts.
      for (const { year, propertyId, monthKey, total } of forecastMap.values()) {
        const fc = getOrCreateForecast('property', propertyId, year);
        saveForecastMonth(fc.id, monthKey, { revenue: total });
      }
    }
    });

    const parts = [`${totalAdded} new`, `${totalUpdated} updated`];
    if (totalRemoved > 0) parts.push(`${totalRemoved} removed`);
    toast(`Imported: ${parts.join(', ')}`, 'success');
    closeModal();
    setTimeout(() => navigate('payments'), 200);
  }});

  openModal({
    title: 'Import Airbnb CSV',
    body,
    footer: [button('Cancel', { onClick: closeModal }), importBtn],
    large: true
  });
}

// RFC-4180-compliant CSV parser with flexible Airbnb column mapping
function parseAirbnbCSV(text) {
  // Strip BOM, normalise line endings
  const clean = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = clean.split('\n');

  const parseLine = (line) => {
    const fields = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (c === ',' && !inQuote) {
        fields.push(cur.trim()); cur = '';
      } else {
        cur += c;
      }
    }
    fields.push(cur.trim());
    return fields;
  };

  const parseAmt = str => Math.abs(parseFloat((str || '').replace(/[^0-9.-]/g, '')) || 0);

  // Find the header row (first non-empty line)
  const headerLine = lines.find(l => l.trim());
  if (!headerLine) return [];
  const headers = parseLine(headerLine).map(h =>
    h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  );

  // Flexible column lookup — tries each name until a match is found
  const headerIdx = new Map(headers.map((h, i) => [h, i]));
  const col = (row, ...candidates) => {
    for (const name of candidates) {
      const exact = headerIdx.get(name);
      if (exact != null && exact < row.length) return (row[exact] ?? '').trim();
      for (const [h, i] of headerIdx) {
        if (h.startsWith(name) && i < row.length) return (row[i] ?? '').trim();
      }
    }
    return '';
  };

  const results = [];
  let foundHeader = false;

  for (const line of lines) {
    if (!foundHeader) { if (line.trim() === headerLine.trim()) { foundHeader = true; } continue; }
    if (!line.trim()) continue;

    const row = parseLine(line);

    // Transaction type — skip "Payout" rows (settlement rows, not reservation data)
    const type = col(row, 'type', 'transaction type') || 'Reservation';
    if (type.toLowerCase() === 'payout') continue;

    // Confirmation Code is the reservation idempotency key; combined with type for uniqueness
    const confirmationCode = col(row, 'confirmation code', 'confirmation', 'reservation code', 'reference', 'transaction id', 'trans id', 'code');
    const airbnbKey = confirmationCode ? `${confirmationCode}|${type}` : null;

    // Dates
    const dateRaw        = col(row, 'date', 'paid date', 'payout date', 'transaction date');
    const bookingDateRaw = col(row, 'booking date', 'booked date', 'booked on');
    const checkInRaw     = col(row, 'start date', 'check in', 'checkin', 'arrival date');
    const checkOutRaw    = col(row, 'end date', 'checkout', 'check out', 'departure date');
    const date           = parseDateStr(dateRaw) || parseDateStr(checkInRaw);
    if (!date) continue;

    const nights = parseInt(col(row, 'nights', 'number of nights'), 10) || 0;

    // Financials
    const amount      = parseAmt(col(row, 'amount', 'payout', 'total amount', 'paid out'));
    const serviceFee  = parseAmt(col(row, 'service fee', 'host fee', 'airbnb fee'));
    const cleaningFee = parseAmt(col(row, 'cleaning fee'));
    // Use the CSV's own "Gross earnings" column when present; otherwise amount + serviceFee
    const grossRaw    = col(row, 'gross earnings', 'gross earning', 'gross');
    const grossEarnings = grossRaw ? parseAmt(grossRaw) : (amount + serviceFee);

    results.push({
      date,
      bookingDate:          parseDateStr(bookingDateRaw) || '',
      checkIn:              parseDateStr(checkInRaw) || '',
      checkOut:             parseDateStr(checkOutRaw) || '',
      nights,
      type,
      confirmationCode,
      airbnbKey,
      amount,
      serviceFee,
      cleaningFee,
      grossEarnings,
      avgGross:             nights > 0 ? Math.round((grossEarnings / nights) * 100) / 100 : 0,
      avgNightInclCleaning: nights > 0 ? Math.round((amount / nights) * 100) / 100 : 0,
      avgNightExclCleaning: nights > 0 ? Math.round(((amount - cleaningFee) / nights) * 100) / 100 : 0,
      currency:             col(row, 'currency', 'currency code') || 'EUR',
      guest:                col(row, 'guest', 'guest name'),
      listing:              col(row, 'listing', 'listing name', 'property')
    });
  }

  return results;
}

// Merge Reservation rows that share the same confirmation code + check-in + check-out
// into a single row with summed monetary fields.  Non-Reservation rows pass through
// unchanged.  The merged row uses a 3-field airbnbKey so it is unique per stay, not
// just per confirmation code.
function mergeReservationRows(rows) {
  const out = [];
  const groups = new Map(); // `${code}|${checkIn}|${checkOut}` → merged row

  for (const row of rows) {
    if (row.type.toLowerCase() === 'reservation' && row.confirmationCode) {
      const gKey = `${row.confirmationCode}|${row.checkIn || ''}|${row.checkOut || ''}`;
      if (groups.has(gKey)) {
        const g = groups.get(gKey);
        g.amount        += row.amount;
        g.serviceFee    += row.serviceFee;
        g.cleaningFee   += row.cleaningFee;
        g.grossEarnings += row.grossEarnings;
      } else {
        const merged = { ...row, airbnbKey: gKey };
        groups.set(gKey, merged);
        out.push(merged);
      }
    } else {
      out.push(row);
    }
  }

  // Recompute per-night averages from the merged totals
  for (const g of groups.values()) {
    if (g.nights > 0) {
      g.avgGross             = Math.round((g.grossEarnings / g.nights) * 100) / 100;
      g.avgNightInclCleaning = Math.round((g.amount / g.nights) * 100) / 100;
      g.avgNightExclCleaning = Math.round(((g.amount - g.cleaningFee) / g.nights) * 100) / 100;
    }
  }

  return out;
}

function parseDateStr(raw) {
  if (!raw) return null;
  // MM/DD/YYYY (Airbnb US export format) — parse manually to avoid timezone shift
  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  // ISO 8601 (YYYY-MM-DD) — Date constructor treats as UTC, no shift
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return raw.slice(0, 10);
  // Last resort: Date constructor (may drift ±1 day near midnight in non-UTC zones)
  const d = new Date(raw);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return null;
}

// Recalculate forecast revenue for a property/month from remaining pending Airbnb payments.
// Call after deleting any pending Airbnb payment so the forecast stays in sync.
function recalcPendingAirbnbForecast(propertyId, monthKey) {
  const year = monthKey.slice(0, 4);
  const total = listActivePayments()
    .filter(p => p.propertyId === propertyId && p.source === 'airbnb' && p.status === 'pending'
      && (p.airbnbCheckIn || p.date || '').slice(0, 7) === monthKey)
    .reduce((s, p) => s + (p.amount || 0), 0);
  const fc = getOrCreateForecast('property', propertyId, year);
  saveForecastMonth(fc.id, monthKey, { revenue: total });
}

function exportCSV() {
  const rows = listActivePayments();
  const headers = [
    'id', 'date', 'propertyId', 'amount', 'currency', 'type', 'status', 'source', 'stream',
    'confirmationCode', 'notes', 'airbnbCheckIn', 'airbnbCheckOut', 'airbnbNights',
    'airbnbGrossEarnings', 'airbnbServiceFee', 'airbnbCleaningFee', 'avgNightExclCleaning', 'avgGross'
  ];
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map(h => JSON.stringify(r[h] ?? '')).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `payments-${today()}.csv`;
  a.click();
  toast('CSV downloaded', 'success');
}
