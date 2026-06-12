// Expenses module
import { state, runBatch } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, select, selVals, input, formRow, textarea, button, fmtDate, today, drillDownModal, buildMultiSelect } from '../core/ui.js';
import { upsert, softDelete, listActive, byId, newId, formatMoney, formatEUR, toEUR, resolveExpenseFields, totalRemaining, fifoDeduct, restoreInventoryStock, findVendorRateByPeriod, getPeopleOwners, getPersonName } from '../core/data.js';
import * as charts from '../core/charts.js';
import { CURRENCIES, EXPENSE_CATEGORIES, EXPENSE_CATEGORY_GROUPS, ACCOUNTING_TYPES, COST_CATEGORIES, RECURRENCE_TYPES, STREAMS } from '../core/config.js';
import { navigate } from '../core/router.js';
import { uploadGithubFile, deleteGithubFile, fetchGithubFile } from '../core/github.js';

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function openReceipt(receipt) {
  let b64;
  if (receipt.path) {
    const file = await fetchGithubFile(receipt.path);
    b64 = file.content.replace(/\s/g, '');
  } else {
    b64 = receipt.data;
  }
  const byteChars = atob(b64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  const blob = new Blob([bytes], { type: receipt.type || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function receiptRepoPath(expenseId, filename) {
  const ext = filename.split('.').pop().toLowerCase();
  return `expenses/receipts/${expenseId}.${ext}`;
}

let _sortCol = -1, _sortDir = 1;
let _expPage = 0, _expPageSize = 100, _expSearch = '';
let _updateFn = null;

export default {
  id: 'expenses',
  label: 'Expenses',
  icon: '💸',
  render(container) { const { element, update } = build(); _updateFn = update; container.appendChild(element); },
  refresh() {
    if (_updateFn) { _updateFn(); return; }
    const c = document.getElementById('content');
    c.innerHTML = '';
    const { element, update } = build();
    _updateFn = update;
    c.appendChild(element);
  },
  destroy() { _updateFn = null; charts.destroyAll(); }
};

function addPeriod(date, period) {
  const d = new Date(date);
  if (period === 'weekly')         d.setDate(d.getDate() + 7);
  else if (period === 'monthly')   d.setMonth(d.getMonth() + 1);
  else if (period === 'quarterly') d.setMonth(d.getMonth() + 3);
  else if (period === 'annually')  d.setFullYear(d.getFullYear() + 1);
  return d;
}

function addOneYear(dateStr) {
  const d = new Date(dateStr);
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}


function build() {
  charts.destroyAll();

  const wrap = el('div', { class: 'view active' });

  const chartsGrid = el('div', { class: 'grid grid-2' },
    el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'By Category')),
      el('div', { class: 'chart-wrap' }, el('canvas', { id: 'chart-exp-cat' }))
    ),
    el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'By Property')),
      el('div', { class: 'chart-wrap' }, el('canvas', { id: 'chart-exp-prop' }))
    )
  );

  const filterBar = el('div', { class: 'flex gap-8 mb-16', style: 'flex-wrap:wrap' });

  const yearFilter       = new Set();
  const monthFilter      = new Set();
  const streamFilter     = new Set();
  const propFilter       = new Set();
  const catFilter        = new Set();
  const accountingTypeFilter = new Set();
  const recurrenceFilter = new Set();

  let selected = new Set();
  let _filterTimer;
  let _expFieldCache = new Map();
  let yearMS, monthMS, streamMS, propMS, catMS, typeMS, recMS;
  const onFilter = () => { clearTimeout(_filterTimer); _filterTimer = setTimeout(() => { rebuildFilters(); renderAll(); }, 250); };

  const deleteSelBtn = button('', { variant: 'danger', onClick: async () => {
    const count = selected.size;
    if (!count) return;
    const ok = await confirmDialog(`Delete ${count} expense(s)? This cannot be undone.`, { danger: true, okLabel: `Delete ${count}` });
    if (!ok) return;
    runBatch(() => {
      for (const id of [...selected]) {
        const exp = byId('expenses', id);
        if (exp) restoreInventoryStock(exp);
        softDelete('expenses', id);
      }
    });
    selected.clear();
    _expFieldCache = new Map();
    toast(`Deleted ${count} expense(s)`, 'success');
    rebuildFilters(); renderAll();
  }});
  deleteSelBtn.style.display = 'none';

  const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function matchesAll(e, skip) {
    const res = resolveExpenseFields(e);
    const yr  = (e.date || '').slice(0, 4);
    const mo  = (e.date || '').slice(5, 7);
    return (
      (skip === 'year'   || yearFilter.size === 0           || yearFilter.has(yr)) &&
      (skip === 'month'  || monthFilter.size === 0          || monthFilter.has(mo)) &&
      (skip === 'stream' || streamFilter.size === 0         || streamFilter.has(e.stream || '')) &&
      (skip === 'prop'   || propFilter.size === 0           || propFilter.has(e.propertyId)) &&
      (skip === 'cat'    || catFilter.size === 0            || catFilter.has(e.category)) &&
      (skip === 'type'   || accountingTypeFilter.size === 0 || accountingTypeFilter.has(res.accountingType)) &&
      (skip === 'rec'    || recurrenceFilter.size === 0     || recurrenceFilter.has(res.recurrence))
    );
  }

  function rebuildFilters() {
    const all = listActive('expenses');

    // Build field cache once so every consumer in this render cycle pays zero extra calls
    _expFieldCache = new Map(all.map(e => [e.id, resolveExpenseFields(e)]));

    // Single pass: inline filter checks so resolveExpenseFields is called once per expense
    const validYrs = new Set(), validMos = new Set(), validSts = new Set(),
          validPrs = new Set(), validCats = new Set(), validTps = new Set(), validRecs = new Set();
    for (const e of all) {
      const res = _expFieldCache.get(e.id);
      const yr  = (e.date || '').slice(0, 4);
      const mo  = (e.date || '').slice(5, 7);
      const st  = e.stream || '';
      const passYr  = yearFilter.size           === 0 || yearFilter.has(yr);
      const passMo  = monthFilter.size          === 0 || monthFilter.has(mo);
      const passSt  = streamFilter.size         === 0 || streamFilter.has(st);
      const passPr  = propFilter.size           === 0 || propFilter.has(e.propertyId);
      const passCat = catFilter.size            === 0 || catFilter.has(e.category);
      const passTp  = accountingTypeFilter.size === 0 || accountingTypeFilter.has(res.accountingType);
      const passRec = recurrenceFilter.size     === 0 || recurrenceFilter.has(res.recurrence);
      if (passMo && passSt && passPr  && passCat && passTp  && passRec) { if (yr) validYrs.add(yr); }
      if (passYr && passSt && passPr  && passCat && passTp  && passRec) { if (mo) validMos.add(mo); }
      if (passYr && passMo && passPr  && passCat && passTp  && passRec) { if (st) validSts.add(st); }
      if (passYr && passMo && passSt  && passCat && passTp  && passRec) { if (e.propertyId)        validPrs.add(e.propertyId); }
      if (passYr && passMo && passSt  && passPr  && passTp  && passRec) { if (e.category)          validCats.add(e.category); }
      if (passYr && passMo && passSt  && passPr  && passCat && passRec) { if (res.accountingType)  validTps.add(res.accountingType); }
      if (passYr && passMo && passSt  && passPr  && passCat && passTp)  { if (res.recurrence)      validRecs.add(res.recurrence); }
    }

    // Prune stale selections
    for (const v of [...yearFilter])           if (!validYrs.has(v))  yearFilter.delete(v);
    for (const v of [...monthFilter])          if (!validMos.has(v))  monthFilter.delete(v);
    for (const v of [...streamFilter])         if (!validSts.has(v))  streamFilter.delete(v);
    for (const v of [...propFilter])           if (!validPrs.has(v))  propFilter.delete(v);
    for (const v of [...catFilter])            if (!validCats.has(v)) catFilter.delete(v);
    for (const v of [...accountingTypeFilter]) if (!validTps.has(v))  accountingTypeFilter.delete(v);
    for (const v of [...recurrenceFilter])     if (!validRecs.has(v)) recurrenceFilter.delete(v);

    const yearOpts   = [...validYrs].sort().reverse().map(y => ({ value: y, label: y }));
    const monthOpts  = [...validMos].sort().map(m => ({ value: m, label: MONTH_LABELS[parseInt(m, 10) - 1] }));
    const streamOpts = [...validSts].sort().map(s => ({ value: s, label: STREAMS[s]?.label || s }));
    const propOpts   = [...validPrs].map(id => byId('properties', id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name)).map(p => ({ value: p.id, label: p.name }));
    const catOpts    = [...validCats].sort().map(c => ({ value: c, label: EXPENSE_CATEGORIES[c]?.label || c }));
    const typeOpts   = [...validTps].sort().map(t => ({ value: t, label: ACCOUNTING_TYPES[t]?.label || t }));
    const recOpts    = [...validRecs].sort().map(r => ({ value: r, label: RECURRENCE_TYPES[r]?.label || r }));

    if (!yearMS) {
      // First build: create multiselects and assemble the filter bar once
      yearMS   = buildMultiSelect(yearOpts,   yearFilter,           'All Years',      onFilter, 'exp_years');
      monthMS  = buildMultiSelect(monthOpts,  monthFilter,          'All Months',     onFilter, 'exp_months');
      streamMS = buildMultiSelect(streamOpts, streamFilter,         'All Streams',    onFilter, 'exp_streams');
      propMS   = buildMultiSelect(propOpts,   propFilter,           'All Properties', onFilter, 'exp_props');
      catMS    = buildMultiSelect(catOpts,    catFilter,            'All Expenses',   onFilter, 'exp_cats');
      typeMS   = buildMultiSelect(typeOpts,   accountingTypeFilter, 'All Types',      onFilter, 'exp_types');
      recMS    = buildMultiSelect(recOpts,    recurrenceFilter,     'All Recurrence', onFilter, 'exp_recurrence');

      filterBar.appendChild(yearMS);
      filterBar.appendChild(monthMS);
      filterBar.appendChild(streamMS);
      filterBar.appendChild(propMS);
      filterBar.appendChild(catMS);
      filterBar.appendChild(typeMS);
      filterBar.appendChild(recMS);
      filterBar.appendChild(button('Reset Filters', { variant: 'sm ghost', onClick: () => {
        yearFilter.clear(); monthFilter.clear(); streamFilter.clear(); propFilter.clear();
        catFilter.clear(); accountingTypeFilter.clear(); recurrenceFilter.clear();
        ['exp_years','exp_months','exp_streams','exp_props','exp_cats','exp_types','exp_recurrence']
          .forEach(k => { try { localStorage.removeItem(`btf:${k}`); } catch {} });
        yearMS.reset(); monthMS.reset(); streamMS.reset(); propMS.reset(); catMS.reset(); typeMS.reset(); recMS.reset();
        rebuildFilters(); renderAll();
      }}));
      filterBar.appendChild(el('div', { class: 'flex-1' }));
      filterBar.appendChild(deleteSelBtn);
      filterBar.appendChild(button('+ Add Expense', { variant: 'primary', onClick: () => openForm() }));
    } else {
      // Subsequent calls: update options in place — no DOM teardown
      yearMS.setItems(yearOpts);
      monthMS.setItems(monthOpts);
      streamMS.setItems(streamOpts);
      propMS.setItems(propOpts);
      catMS.setItems(catOpts);
      typeMS.setItems(typeOpts);
      recMS.setItems(recOpts);
    }
  }

  wrap.appendChild(filterBar);
  wrap.appendChild(chartsGrid);

  // Data-level search box (filters the whole dataset, not just the visible page)
  const searchWrap = el('div', { style: 'display:flex;justify-content:flex-end;margin-bottom:8px' });
  const searchInput = el('input', { type: 'search', class: 'input', placeholder: 'Filter expenses…', style: 'max-width:220px;font-size:13px' });
  searchInput.value = _expSearch;
  searchWrap.appendChild(searchInput);
  wrap.appendChild(searchWrap);

  const tableWrap = el('div', { class: 'table-wrap' });
  wrap.appendChild(tableWrap);

  const pagerWrap = el('div', { class: 'flex justify-between', style: 'align-items:center;margin-top:10px;flex-wrap:wrap;gap:8px' });
  wrap.appendChild(pagerWrap);

  let _searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => { _expSearch = searchInput.value.trim().toLowerCase(); _expPage = 0; renderTable(); }, 200);
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

  // Derive an expense's display + sort/search values once, reused by every consumer.
  const derive = (r) => {
    const res  = _expFieldCache.get(r.id) || resolveExpenseFields(r);
    const prop = byId('properties', r.propertyId);
    const cat  = EXPENSE_CATEGORIES[r.category];
    const catLabel = cat?.label || r.category;
    const vendorPerson = r.personId
      ? ((state.db.people || []).find(p => p.id === r.personId || (p.legacyKey || p.id) === r.personId)?.name || r.personId)
      : (r.vendorId ? (byId('vendors', r.vendorId)?.name || r.vendor || '') : (r.vendor || ''));
    const eur = toEUR(r.amount, r.currency);
    // No property → business-line allocation: show the stream label instead of "-"
    const allocName = prop?.name || (r.stream ? (STREAMS[r.stream]?.label || 'Company') : 'Company');
    return {
      r, res, prop, cat, catLabel, vendorPerson, eur,
      propName: allocName,
      isCapex: res.accountingType === 'capex',
      searchText: [fmtDate(r.date), allocName, catLabel, r.description, vendorPerson, r.currency].filter(Boolean).join(' ').toLowerCase()
    };
  };

  // Sort accessors, one per data column (matches the header order below).
  const colAccessors = [
    d => d.r.date, d => d.propName, d => d.catLabel, d => (d.r.description || ''), d => d.vendorPerson, d => d.eur, d => d.eur
  ];
  const HEADERS = [
    ['Date', ''], ['Property', ''], ['Category', ''], ['Description', ''], ['Vendor / Person', ''],
    ['Amount', 'right'], ['EUR', 'right']
  ];

  const renderTable = () => {
    selected.clear();
    syncDeleteBtn();
    tableWrap.innerHTML = '';
    pagerWrap.innerHTML = '';

    const allExpenses = listActive('expenses');
    // Ensure cache is warm (may be empty when renderTable is called directly after a delete/edit)
    if (_expFieldCache.size === 0) {
      _expFieldCache = new Map(allExpenses.map(e => [e.id, resolveExpenseFields(e)]));
    }

    // 1. Facet filters
    let derived = allExpenses.filter(r => {
      if (yearFilter.size > 0           && !yearFilter.has((r.date || '').slice(0, 4)))                return false;
      if (monthFilter.size > 0          && !monthFilter.has((r.date || '').slice(5, 7)))               return false;
      if (streamFilter.size > 0         && !streamFilter.has(r.stream || ''))                          return false;
      if (propFilter.size > 0           && !propFilter.has(r.propertyId))                              return false;
      if (catFilter.size > 0            && !catFilter.has(r.category))                                 return false;
      const res = _expFieldCache.get(r.id);
      if (accountingTypeFilter.size > 0 && !accountingTypeFilter.has(res?.accountingType))             return false;
      if (recurrenceFilter.size > 0     && !recurrenceFilter.has(res?.recurrence))                     return false;
      return true;
    }).map(derive);

    // 2. Text search (whole dataset)
    if (_expSearch) derived = derived.filter(d => d.searchText.includes(_expSearch));

    // 3. Sort (date desc by default, otherwise by clicked column)
    if (_sortCol >= 0 && colAccessors[_sortCol]) {
      const acc = colAccessors[_sortCol], dir = _sortDir;
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
      tableWrap.appendChild(el('div', { class: 'empty' }, _expSearch ? 'No expenses match your search' : 'No expenses'));
      return;
    }

    // Footer totals computed over the full filtered set
    let totalEUR = 0, capexEUR = 0;
    for (const d of derived) { totalEUR += d.eur; if (d.isCapex) capexEUR += d.eur; }

    // 4. Paginate
    const pageCount = Math.max(1, Math.ceil(total / _expPageSize));
    if (_expPage >= pageCount) _expPage = pageCount - 1;
    if (_expPage < 0) _expPage = 0;
    const startIdx = _expPage * _expPageSize;
    const pageRows = derived.slice(startIdx, startIdx + _expPageSize);

    const t = el('table', { class: 'table' });
    const selectAllChk = el('input', { type: 'checkbox', style: 'cursor:pointer' });
    const htr = el('tr', {});
    const chkTh = el('th', { style: 'width:36px' }); chkTh.appendChild(selectAllChk);
    htr.appendChild(chkTh);
    HEADERS.forEach(([label, cls], i) => {
      const th = el('th', cls ? { class: cls } : {}, label);
      th.style.cursor = 'pointer';
      th.style.userSelect = 'none';
      const arr = el('span', { style: 'margin-left:4px;font-size:10px;opacity:' + (_sortCol === i ? '1' : '0.4') },
        _sortCol === i ? (_sortDir > 0 ? ' ▲' : ' ▼') : ' ⇅');
      th.appendChild(arr);
      th.onclick = () => {
        if (_sortCol === i) _sortDir *= -1; else { _sortCol = i; _sortDir = 1; }
        _expPage = 0;
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
      const { r, res, cat } = d;
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
      const catCell = el('td', {});
      catCell.appendChild(el('span', { class: 'badge ' + (r.category === 'renovation' ? 'warning' : '') }, d.catLabel));
      if (res.accountingType === 'capex' && r.category !== 'renovation')
        catCell.appendChild(el('span', { class: 'badge warning', style: 'margin-left:4px;font-size:10px' }, 'CapEx'));
      tr.appendChild(catCell);
      const descCell = el('td', {});
      if (r.recurringGroupId) descCell.appendChild(el('span', { class: 'badge', style: 'margin-right:4px;font-size:10px' }, '↻'));
      descCell.appendChild(document.createTextNode(r.description || ''));
      tr.appendChild(descCell);
      tr.appendChild(el('td', {}, d.vendorPerson));
      tr.appendChild(el('td', { class: 'right num' }, formatMoney(r.amount, r.currency, { maxFrac: 0 })));
      tr.appendChild(el('td', { class: 'right num muted' }, r.currency === 'EUR' ? '' : formatEUR(d.eur)));
      const actions = el('td', { class: 'right' });
      if (r.receipt) {
        const rcptBtn = button('📎', { variant: 'sm ghost' });
        rcptBtn.title = `Receipt: ${r.receipt.name}`;
        rcptBtn.onclick = async () => {
          try { await openReceipt(r.receipt); } catch (e) { toast('Could not open receipt: ' + e.message, 'danger'); }
        };
        actions.appendChild(rcptBtn);
      }
      actions.appendChild(button('Edit', { variant: 'sm ghost', onClick: () => openForm(r) }));
      actions.appendChild(button('Del', { variant: 'sm ghost', onClick: async () => {
        const ok = await confirmDialog('Delete expense?', { danger: true, okLabel: 'Delete' });
        if (ok) { restoreInventoryStock(r); softDelete('expenses', r.id); _expFieldCache = new Map(); toast('Deleted', 'success'); renderTable(); }
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
      el('span', { class: 'muted' }, `${total} expense(s) · CapEx: `, formatEUR(capexEUR)),
      el('span', {}, 'Total: ', el('strong', { class: 'num' }, formatEUR(totalEUR)))
    ));

    // Pagination controls
    const endIdx = Math.min(startIdx + _expPageSize, total);
    const prevBtn = button('‹ Prev', { variant: 'sm ghost', onClick: () => { if (_expPage > 0) { _expPage--; renderTable(); } } });
    const nextBtn = button('Next ›', { variant: 'sm ghost', onClick: () => { if (_expPage < pageCount - 1) { _expPage++; renderTable(); } } });
    prevBtn.disabled = _expPage === 0;
    nextBtn.disabled = _expPage >= pageCount - 1;
    const sizeSel = select(PAGE_SIZES.map(n => ({ value: String(n), label: `${n} / page` })), String(_expPageSize));
    sizeSel.style.maxWidth = '120px';
    sizeSel.onchange = () => { _expPageSize = Number(sizeSel.value); _expPage = 0; renderTable(); };
    pagerWrap.appendChild(el('span', { class: 'muted', style: 'font-size:13px' }, `Showing ${startIdx + 1}–${endIdx} of ${total}`));
    pagerWrap.appendChild(el('div', { class: 'flex gap-8', style: 'align-items:center;flex-wrap:wrap' },
      sizeSel, prevBtn, el('span', { style: 'font-size:13px' }, `Page ${_expPage + 1} / ${pageCount}`), nextBtn
    ));
  };

  // Drilldown helpers shared by both charts
  const drillCols = [
    { key: 'date',          label: 'Date',        format: v => fmtDate(v) },
    { key: 'property',      label: 'Property' },
    { key: 'category',      label: 'Category' },
    { key: 'accountingType',label: 'Type' },
    { key: 'recurrence',    label: 'Recurrence' },
    { key: 'desc',          label: 'Description' },
    { key: 'vendor',        label: 'Vendor / Person' },
    { key: 'eur',           label: 'Amount (€)',  right: true, format: v => formatEUR(v) },
  ];
  const toDrillRows = rows => rows
    .map(r => {
      const res = resolveExpenseFields(r);
      return {
        date:          r.date,
        property:      byId('properties', r.propertyId)?.name || '—',
        category:      EXPENSE_CATEGORIES[r.category]?.label || r.category,
        accountingType: ACCOUNTING_TYPES[res.accountingType]?.label || res.accountingType,
        recurrence:    RECURRENCE_TYPES[res.recurrence]?.label || res.recurrence,
        desc:          r.description || '—',
        vendor:        r.personId
          ? ((state.db.people || []).find(p => p.id === r.personId || (p.legacyKey || p.id) === r.personId)?.name || r.personId)
          : (r.vendorId ? (byId('vendors', r.vendorId)?.name || r.vendor || '—') : (r.vendor || '—')),
        eur:           toEUR(r.amount, r.currency),
      };
    })
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const renderDash = () => {
    const allExp = listActive('expenses');
    // Cache may be stale if expenses were added externally; rebuild if needed
    if (_expFieldCache.size === 0) {
      _expFieldCache = new Map(allExp.map(e => [e.id, resolveExpenseFields(e)]));
    }
    const bkRows = allExp.filter(r => {
      if (yearFilter.size > 0           && !yearFilter.has((r.date || '').slice(0, 4)))                return false;
      if (monthFilter.size > 0          && !monthFilter.has((r.date || '').slice(5, 7)))               return false;
      if (streamFilter.size > 0         && !streamFilter.has(r.stream || ''))                          return false;
      if (propFilter.size > 0           && !propFilter.has(r.propertyId))                              return false;
      if (catFilter.size > 0            && !catFilter.has(r.category))                                 return false;
      const res = _expFieldCache.get(r.id);
      if (accountingTypeFilter.size > 0 && !accountingTypeFilter.has(res?.accountingType))             return false;
      if (recurrenceFilter.size > 0     && !recurrenceFilter.has(res?.recurrence))                     return false;
      return true;
    });

    // By Cost Category doughnut (groups by resolved costCategory for correct OpEx/CapEx separation)
    const byCostCat = new Map();
    for (const r of bkRows) {
      const k = _expFieldCache.get(r.id)?.costCategory;
      byCostCat.set(k, (byCostCat.get(k) || 0) + toEUR(r.amount, r.currency));
    }
    const catLabels = [], catData = [], catColors = [], catKeys = [];
    for (const [k, m] of Object.entries(COST_CATEGORIES)) {
      if (!byCostCat.has(k)) continue;
      catLabels.push(m.label);
      catData.push(Math.round(byCostCat.get(k)));
      catColors.push(m.color);
      catKeys.push(k);
    }
    charts.doughnut('chart-exp-cat', {
      labels: catLabels, data: catData, colors: catColors,
      onClickItem: (_label, idx) => {
        const key = catKeys[idx];
        drillDownModal(
          `Expenses — ${COST_CATEGORIES[key]?.label || key}`,
          toDrillRows(bkRows.filter(r => (_expFieldCache.get(r.id) || resolveExpenseFields(r)).costCategory === key)),
          drillCols
        );
      }
    });

    // By Property bar chart
    const byProp = new Map();
    for (const r of bkRows) byProp.set(r.propertyId, (byProp.get(r.propertyId) || 0) + toEUR(r.amount, r.currency));
    const propLabels = [], propData = [], propIds = [];
    const propColors = ['#6366f1', '#8b5cf6', '#14b8a6', '#ec4899', '#f59e0b', '#3b82f6'];
    for (const [id, val] of [...byProp.entries()].sort((a, b) => b[1] - a[1])) {
      propLabels.push(byId('properties', id)?.name || 'Unknown');
      propData.push(Math.round(val));
      propIds.push(id);
    }
    charts.bar('chart-exp-prop', {
      labels: propLabels,
      datasets: [{ label: 'EUR', data: propData, backgroundColor: propColors }],
      horizontal: true,
      onClickItem: (_label, idx) => {
        const pid = propIds[idx];
        drillDownModal(
          `Expenses — ${byId('properties', pid)?.name || 'Unknown'}`,
          toDrillRows(bkRows.filter(r => r.propertyId === pid)),
          drillCols
        );
      }
    });
  };

  const renderAll = () => { renderTable(); requestAnimationFrame(() => renderDash()); };

  rebuildFilters();
  requestAnimationFrame(() => { renderTable(); requestAnimationFrame(() => renderDash()); });

  return { element: wrap, update: () => { _expFieldCache = new Map(); rebuildFilters(); renderAll(); } };
}

function findCleaningRates(propertyId, date) {
  return findVendorRateByPeriod(propertyId, date, '').filter(m => m.vendor.role === 'cleaner');
}

export function openExpenseForm(id, { onSave } = {}) {
  if (id && typeof id === 'object') { openForm(null, id, onSave); return; }
  const exp = byId('expenses', id);
  if (exp) openForm(exp, {}, onSave);
}

function buildCategorySelect(currentValue) {
  const HIDDEN = new Set(['owner_rent']);
  const grouped = new Set(Object.values(EXPENSE_CATEGORY_GROUPS).flatMap(g => g.subtypes));
  const s = el('select', { class: 'select' });
  for (const [key, meta] of Object.entries(EXPENSE_CATEGORIES)) {
    if (grouped.has(key) || HIDDEN.has(key)) continue;
    const opt = el('option', { value: key }, meta.label);
    if (key === currentValue) opt.selected = true;
    s.appendChild(opt);
  }
  for (const group of Object.values(EXPENSE_CATEGORY_GROUPS)) {
    const og = el('optgroup', { label: group.label });
    for (const key of group.subtypes) {
      const meta = EXPENSE_CATEGORIES[key];
      if (!meta || HIDDEN.has(key)) continue;
      const opt = el('option', { value: key }, meta.label);
      if (key === currentValue) opt.selected = true;
      og.appendChild(opt);
    }
    s.appendChild(og);
  }
  return s;
}

function openForm(existing, defaults = {}, onSave = null) {
  const r = existing ? { ...existing } : {
    id: newId('exp'),
    propertyId: state.db.properties?.[0]?.id || '',
    category: 'maintenance',
    amount: 0, currency: 'EUR',
    date: today(),
    vendor: '', vendorId: '', description: '',
    stream: 'short_term_rental',
    ...defaults
  };

  const body = el('div', {});
  // "Allocated To" — a specific property, or a business line (stream) for
  const COMPANY_VALUE = '__company__';
  const allocS = el('select', { class: 'select' });
  {
    const propOg = el('optgroup', { label: 'Properties' });
    for (const p of (state.db.properties || [])) propOg.appendChild(el('option', { value: p.id }, p.name));
    if (propOg.children.length) allocS.appendChild(propOg);
    allocS.appendChild(el('option', { value: COMPANY_VALUE }, 'Company'));
  }
  allocS.value = r.propertyId ? r.propertyId : COMPANY_VALUE;
  const allocPid = () => allocS.value === COMPANY_VALUE ? '' : allocS.value;
  const catS = buildCategorySelect(r.category);
  const resolved = resolveExpenseFields(r);
  const accountingTypeS = select(Object.entries(ACCOUNTING_TYPES).map(([v, m]) => ({ value: v, label: m.label })), resolved.accountingType);
  const costCategoryS   = select(Object.entries(COST_CATEGORIES).map(([v, m]) => ({ value: v, label: m.label })), resolved.costCategory);
  const recurrenceS     = select(Object.entries(RECURRENCE_TYPES).map(([v, m]) => ({ value: v, label: m.label })), resolved.recurrence);
  // Association toggle (Vendor | Person)
  let assocMode = r.personId ? 'person' : 'vendor';

  const vendorOpts = [{ value: '', label: '— No vendor —' }, ...(state.db.vendors || []).map(v => ({ value: v.id, label: v.name }))];
  const vendorS = select(vendorOpts, r.vendorId || '');

  const personOpts = [{ value: '', label: '— Select person —' }, ...getPeopleOwners()];
  const personS = select(personOpts, r.personId || '');

  const piChk = el('input', { type: 'checkbox' });
  piChk.checked = !!r.countsAsPersonalIncome;
  const piRow = el('div', { style: 'display:flex;align-items:center;gap:8px;margin-top:6px;padding:6px 10px;background:rgba(99,102,241,0.07);border-radius:4px;border:1px solid rgba(99,102,241,0.15)' },
    piChk,
    el('label', { style: 'font-size:12px;color:var(--text);cursor:pointer;user-select:none' }, 'Include in Personal Income for this person')
  );
  piChk.id = 'piChk_' + r.id;
  piRow.querySelector('label').htmlFor = piChk.id;

  const vendorRow  = el('div', {}, formRow('Vendor', vendorS));
  const personWrap = el('div', {}, formRow('Person', personS), piRow);
  const cleaningHint = el('div', { style: 'font-size:12px;color:var(--text-muted);padding:2px 0 6px' });

  const assocVendorBtn = el('button', {
    type: 'button',
    style: 'padding:4px 12px;border-radius:14px;font-size:12px;cursor:pointer;border:1px solid;transition:all 120ms'
  }, 'Vendor');
  const assocPersonBtn = el('button', {
    type: 'button',
    style: 'padding:4px 12px;border-radius:14px;font-size:12px;cursor:pointer;border:1px solid;transition:all 120ms'
  }, 'Person');

  const syncAssocBtns = () => {
    const isVendor = assocMode === 'vendor';
    assocVendorBtn.style.cssText = isVendor
      ? 'padding:4px 12px;border-radius:14px;font-size:12px;cursor:pointer;border:1px solid var(--accent);background:var(--accent);color:#fff;font-weight:600;transition:all 120ms'
      : 'padding:4px 12px;border-radius:14px;font-size:12px;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--text-muted);transition:all 120ms';
    assocPersonBtn.style.cssText = !isVendor
      ? 'padding:4px 12px;border-radius:14px;font-size:12px;cursor:pointer;border:1px solid var(--accent);background:var(--accent);color:#fff;font-weight:600;transition:all 120ms'
      : 'padding:4px 12px;border-radius:14px;font-size:12px;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--text-muted);transition:all 120ms';
    vendorRow.style.display  = isVendor ? '' : 'none';
    personWrap.style.display = !isVendor ? '' : 'none';
  };

  assocVendorBtn.onclick = () => { assocMode = 'vendor'; syncAssocBtns(); };
  assocPersonBtn.onclick = () => { assocMode = 'person'; syncAssocBtns(); };
  syncAssocBtns();

  const assocToggle = el('div', {},
    formRow('Associate with', el('div', { style: 'display:flex;gap:6px' }, assocVendorBtn, assocPersonBtn))
  );

  const amountI = input({ type: 'number', value: r.amount, min: 0, step: 0.01 });
  const currencyS = select(CURRENCIES, r.currency);
  const dateI = input({ type: 'date', value: r.date });
  const descT = textarea({ placeholder: 'Description' });
  descT.value = r.description || '';

  const invItemS = el('select', { class: 'select' });
  const invQtyI  = input({ type: 'number', value: r.inventoryQty || 1, min: 1, step: 1 });
  const invRow   = el('div', { class: 'form-row horizontal' }, formRow('Item', invItemS), formRow('Qty', invQtyI));

  const updateInvItemOpts = () => {
    const pid   = allocPid();
    const items = listActive('inventory').filter(i => !pid || i.propertyId === pid);
    invItemS.innerHTML = '';
    const placeholder = el('option', { value: '' }, '— Select item —');
    invItemS.appendChild(placeholder);
    for (const item of items) {
      const alreadyConsumed = existing?.inventoryItemId === item.id ? (existing.inventoryQty || 0) : 0;
      const avail = totalRemaining(item) + alreadyConsumed;
      const opt = el('option', { value: item.id }, `${item.name} (${avail} avail)`);
      if (item.id === (r.inventoryItemId || '')) opt.selected = true;
      invItemS.appendChild(opt);
    }
  };
  updateInvItemOpts();

  // Recurring — only shown for new expenses
  const recurChk = el('input', { type: 'checkbox' });
  const recurPeriodS = select([
    { value: 'weekly',    label: 'Weekly' },
    { value: 'monthly',   label: 'Monthly' },
    { value: 'quarterly', label: 'Quarterly' },
    { value: 'annually',  label: 'Annually' }
  ], 'monthly');
  const recurEndI = input({ type: 'date', value: addOneYear(r.date || today()) });
  const recurOptsRow = el('div', { class: 'form-row horizontal' }, formRow('Period', recurPeriodS), formRow('Repeat Until', recurEndI));
  recurOptsRow.style.display = 'none';
  recurChk.onchange = () => {
    recurOptsRow.style.display = recurChk.checked ? '' : 'none';
    recurrenceS.value = recurChk.checked ? 'recurring' : 'one_off';
  };

  const accountingTypeRow = el('div', { class: 'form-row horizontal' }, formRow('Expense Type', accountingTypeS));

  body.appendChild(formRow('Allocated To', allocS));
  body.appendChild(formRow('Category', catS));
  body.appendChild(accountingTypeRow);
  body.appendChild(invRow);
  body.appendChild(assocToggle);
  body.appendChild(vendorRow);
  body.appendChild(personWrap);
  body.appendChild(cleaningHint);
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Amount', amountI), formRow('Currency', currencyS)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Date', dateI)));
  if (existing && resolved.recurrence === 'recurring') {
    body.appendChild(el('div', { style: 'padding:4px 0 2px;font-size:12px;color:var(--text-muted)' }, '↻ Recurring expense'));
  }
  if (!existing) {
    body.appendChild(el('div', { style: 'padding:8px 0 2px' },
      el('label', { style: 'display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px' }, recurChk, ' Recurring'),
      recurOptsRow
    ));
  }
  body.appendChild(formRow('Description', descT));

  // ── Receipt upload ────────────────────────────────────────────────────────────
  let pendingReceiptFile = null;
  let removeExistingReceipt = false;

  const receiptWrap = el('div', { style: 'margin-top:4px' });
  const receiptStatus = el('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:4px' });
  const fileInput = el('input', { type: 'file', accept: '.pdf,.jpg,.jpeg,.png,.gif,.webp', style: 'display:none' });

  const chooseBtn  = button('📎 Attach Receipt', { variant: 'sm ghost' });
  const viewBtn    = button('View', { variant: 'sm ghost' });
  const removeBtn  = button('Remove', { variant: 'sm ghost' });
  removeBtn.style.color = 'var(--danger,#dc3545)';

  const btnRow = el('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap' });
  btnRow.appendChild(chooseBtn);
  btnRow.appendChild(fileInput);

  const syncReceiptUI = () => {
    viewBtn.remove(); removeBtn.remove();
    if (pendingReceiptFile) {
      receiptStatus.textContent = `📎 ${pendingReceiptFile.name} (pending upload)`;
      btnRow.appendChild(removeBtn);
    } else if (r.receipt && !removeExistingReceipt) {
      receiptStatus.textContent = `📎 ${r.receipt.name}`;
      btnRow.appendChild(viewBtn);
      btnRow.appendChild(removeBtn);
    } else {
      receiptStatus.textContent = '';
    }
  };

  chooseBtn.onclick = () => fileInput.click();
  fileInput.onchange = () => {
    pendingReceiptFile = fileInput.files[0] || null;
    removeExistingReceipt = false;
    syncReceiptUI();
  };
  viewBtn.onclick = async () => {
    try { await openReceipt(r.receipt); } catch (e) { toast('Could not open receipt: ' + e.message, 'danger'); }
  };
  removeBtn.onclick = () => {
    pendingReceiptFile = null;
    removeExistingReceipt = true;
    fileInput.value = '';
    syncReceiptUI();
  };

  receiptWrap.appendChild(receiptStatus);
  receiptWrap.appendChild(btnRow);
  body.appendChild(formRow('Receipt', receiptWrap));
  syncReceiptUI();

  const autoFillAmount = () => {
    if (catS.value === 'inventory') return;
    cleaningHint.textContent = '';

    if (catS.value === 'cleaning') {
      const propId = allocPid();
      const date   = dateI.value;
      if (!propId || !date) return;

      const matches = findCleaningRates(propId, date);
      if (matches.length === 0) {
        cleaningHint.textContent = 'No cleaning rate configured for this property and date.';
        return;
      }
      if (matches.length === 1) {
        const { vendor, period } = matches[0];
        if (!vendorS.value) vendorS.value = vendor.id;
        if (Number(amountI.value) === 0) amountI.value = period.fee;
        return;
      }
      // Multiple matches — require vendor selection
      if (vendorS.value) {
        const hit = matches.find(m => m.vendor.id === vendorS.value);
        if (hit) {
          if (Number(amountI.value) === 0) amountI.value = hit.period.fee;
          return;
        }
      }
      cleaningHint.textContent = 'Multiple cleaners available for this property and date. Please select a vendor.';
      return;
    }

    // Non-cleaning: auto-fill from vendor flat rate or property utility defaults
    if (Number(amountI.value) > 0) return;
    const prop = byId('properties', allocPid());
    if (!prop) return;
    if (vendorS.value) {
      const vendor = byId('vendors', vendorS.value);
      if (vendor?.rates?.[prop.id]) { amountI.value = vendor.rates[prop.id]; return; }
    }
    if (catS.value === 'electricity' && prop.monthlyElectricity) amountI.value = prop.monthlyElectricity;
    else if (catS.value === 'water' && prop.monthlyWater) amountI.value = prop.monthlyWater;
  };

  const syncInventoryAmount = () => {
    const item = byId('inventory', invItemS.value);
    if (!item) return;
    const qty = Number(invQtyI.value) || 1;
    if (item.batches) {
      const { totalCost } = fifoDeduct(item, qty);
      amountI.value = totalCost.toFixed(2);
      currencyS.value = item.batches.find(b => b.currency)?.currency || 'EUR';
    } else {
      // Legacy flat item
      amountI.value = ((item.unitPrice || 0) * qty).toFixed(2);
      currencyS.value = item.currency || 'EUR';
    }
  };

  const syncInventoryRow = () => {
    const isInv = catS.value === 'inventory';
    invRow.style.display      = isInv ? '' : 'none';
    assocToggle.style.display = isInv ? 'none' : '';
    vendorRow.style.display   = isInv ? 'none' : (assocMode === 'vendor' ? '' : 'none');
    personWrap.style.display  = isInv ? 'none' : (assocMode === 'person' ? '' : 'none');
  };
  syncInventoryRow();

  const syncAccountingTypeRow = () => {
    accountingTypeRow.style.display = catS.value === 'other' ? '' : 'none';
  };
  syncAccountingTypeRow();

  catS.onchange = () => {
    if (catS.value === 'renovation') {
      accountingTypeS.value = 'capex';
      costCategoryS.value   = 'renovation';
    } else {
      accountingTypeS.value = 'opex';
      costCategoryS.value = resolveExpenseFields({ category: catS.value }).costCategory;
    }
    syncAccountingTypeRow();
    syncInventoryRow();
    if (catS.value === 'inventory') syncInventoryAmount();
    else autoFillAmount();
  };
  vendorS.onchange = autoFillAmount;
  dateI.onchange   = autoFillAmount;
  allocS.onchange = () => {
    const p = byId('properties', allocPid());
    if (p) currencyS.value = p.currency;
    autoFillAmount();
    updateInvItemOpts();
  };
  invItemS.onchange = syncInventoryAmount;
  invQtyI.oninput   = syncInventoryAmount;

  const save = button('Save', { variant: 'primary', onClick: async () => {
    if (!allocS.value) { toast('Select what this expense is allocated to', 'danger'); return; }

    if (catS.value === 'inventory') {
      const itemId = invItemS.value;
      const qty    = Number(invQtyI.value) || 0;
      if (!itemId) { toast('Select an inventory item', 'danger'); return; }
      if (qty <= 0) { toast('Quantity must be > 0', 'danger'); return; }

      // Restore previous consumption first (handles item switch or qty change)
      if (existing?.inventoryItemId) restoreInventoryStock(existing);

      const item = byId('inventory', itemId);
      if (!item) { toast('Item not found', 'danger'); return; }
      const available = totalRemaining(item);

      if (qty > available) {
        const ok = await confirmDialog(
          `Only ${available} in stock. Record expense anyway?`,
          { okLabel: 'Override', danger: true }
        );
        if (!ok) return;
      }

      const { updatedBatches, consumed, totalCost } = fifoDeduct(item, qty);
      upsert('inventory', { ...item, batches: updatedBatches });
      amountI.value = totalCost.toFixed(2);
      currencyS.value = consumed[0]?.currency || item.batches?.[0]?.currency || 'EUR';
      r.inventoryItemId  = itemId;
      r.inventoryQty     = qty;
      r.inventoryBatches = consumed;
    } else {
      if (existing?.inventoryItemId) restoreInventoryStock(existing);
      r.inventoryItemId  = '';
      r.inventoryQty     = 0;
      r.inventoryBatches = [];
    }

    if (catS.value !== 'inventory' && Number(amountI.value) <= 0) { toast('Amount required', 'danger'); return; }
    const selectedVendor = vendorS.value ? byId('vendors', vendorS.value) : null;
    const prop = byId('properties', allocPid());
    const autoStream = prop?.type === 'short_term' ? 'short_term_rental'
      : prop?.type === 'long_term' ? 'long_term_rental'
      : (r.stream || null);
    const appliedFee = catS.value === 'cleaning' && Number(amountI.value) > 0 ? Number(amountI.value) : undefined;
    Object.assign(r, {
      propertyId:    allocPid(),
      category:      catS.value,
      accountingType: catS.value === 'renovation' ? 'capex' : accountingTypeS.value,
      costCategory:   catS.value === 'renovation' ? 'renovation' : costCategoryS.value,
      recurrence:    recurrenceS.value,
      amount:        Number(amountI.value),
      currency:      currencyS.value,
      date:          dateI.value,
      personId:             assocMode === 'person' ? (personS.value || '') : '',
      countsAsPersonalIncome: assocMode === 'person' && !!piChk.checked,
      vendorId:      assocMode === 'vendor' ? (vendorS.value || '') : '',
      vendor:        assocMode === 'vendor' ? (selectedVendor?.name || r.vendor || '') : '',
      description:   descT.value.trim(),
      stream:        autoStream,
      ...(appliedFee !== undefined ? { appliedCleaningFee: appliedFee } : {})
    });

    // ── Receipt handling ────────────────────────────────────────────────────────
    if (removeExistingReceipt && r.receipt?.path) {
      try { await deleteGithubFile(r.receipt.path, null, `Remove receipt for expense ${r.id}`); } catch { /* ignore */ }
      delete r.receipt;
    }
    if (pendingReceiptFile) {
      const b64 = await readFileAsBase64(pendingReceiptFile);
      const repoPath = receiptRepoPath(r.id, pendingReceiptFile.name);
      const { token, owner, repo } = state.github;
      if (token && owner && repo) {
        // Delete old receipt file if replacing
        if (r.receipt?.path && r.receipt.path !== repoPath) {
          try { await deleteGithubFile(r.receipt.path, null, `Replace receipt for expense ${r.id}`); } catch { /* ignore */ }
        }
        try {
          await uploadGithubFile(repoPath, b64, `Upload receipt for expense ${r.id}`);
          r.receipt = { name: pendingReceiptFile.name, type: pendingReceiptFile.type, path: repoPath };
        } catch {
          r.receipt = { name: pendingReceiptFile.name, type: pendingReceiptFile.type, data: b64 };
        }
      } else {
        r.receipt = { name: pendingReceiptFile.name, type: pendingReceiptFile.type, data: b64 };
      }
    } else if (removeExistingReceipt) {
      delete r.receipt;
    }

    if (!existing && recurChk.checked && catS.value !== 'inventory') {
      const period  = recurPeriodS.value;
      const endDate = recurEndI.value || addOneYear(r.date);
      const groupId = newId('rgrp');
      let d = new Date(r.date);
      const end = new Date(endDate);
      let count = 0;
      while (d <= end && count < 120) {
        upsert('expenses', { ...r, id: newId('exp'), date: d.toISOString().slice(0, 10), recurringGroupId: groupId });
        d = addPeriod(d, period);
        count++;
      }
      toast(`${count} recurring expense(s) added`, 'success');
    } else if (existing?.recurringGroupId) {
      const choice = await new Promise(resolve => {
        let settled = false;
        const settle = v => { if (!settled) { settled = true; resolve(v); } };
        const thisBtn = button('This instance only', { variant: 'primary', onClick: () => { close(); settle('one'); } });
        const allBtn  = button('All occurrences',    { variant: 'primary', onClick: () => { close(); settle('all'); } });
        const cancelBtn = button('Cancel', { onClick: () => { close(); settle(null); } });
        const { close } = openModal({
          title: 'Edit Recurring Expense',
          body: el('p', {}, 'Do you want to apply this change to this instance only, or to all occurrences in the group?'),
          footer: [cancelBtn, thisBtn, allBtn],
          onClose: () => settle(null),
        });
      });
      if (!choice) return;
      if (choice === 'all') {
        const siblings = listActive('expenses').filter(e => e.recurringGroupId === existing.recurringGroupId);
        const { id: _id, date: _date, recurringGroupId: _grp, isGenerated: _gen, manualOverride: _mo, ...sharedFields } = r;
        for (const sib of siblings) {
          upsert('expenses', { ...sib, ...sharedFields });
        }
        toast(`${siblings.length} occurrence(s) updated`, 'success');
      } else {
        if (existing.isGenerated) r.manualOverride = true;
        upsert('expenses', r);
        toast('Expense updated', 'success');
      }
    } else {
      if (existing?.isGenerated) r.manualOverride = true;
      upsert('expenses', r);
      toast(existing ? 'Expense updated' : 'Expense added', 'success');
    }
    closeModal();
    if (onSave) setTimeout(onSave, 200);
    else setTimeout(() => navigate('expenses'), 200);
  }});
  const cancel = button('Cancel', { onClick: closeModal });
  openModal({ title: existing ? 'Edit Expense' : 'New Expense', body, footer: [cancel, save] });
}
