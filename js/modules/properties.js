// Properties module
import { state } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, select, input, formRow, textarea, button, fmtDate, buildMultiSelect } from '../core/ui.js';
import {
  upsert, softDelete, listActive, listActivePayments, byId, newId, formatEUR, formatMoney, toEUR,
  propertyRevenueEUR, propertyExpensesEUR, renovationCapexEUR, propertyROI,
  getPeopleOwners, getPersonName, restoreInventoryStock, removeReservationExpenses
} from '../core/data.js';
import { PROPERTY_TYPES, PROPERTY_STATUSES, CURRENCIES, OWNERS, VENDOR_ROLES, PROPERTY_CHANNELS, EXPENSE_CATEGORIES } from '../core/config.js';
import { fetchICal, parseICal, nights } from '../core/ical.js';
import { openExpenseForm } from './expenses.js';
import { navigate } from '../core/router.js';
import { uploadGithubFile, deleteGithubFile, fetchGithubFile } from '../core/github.js';

let selectedId = null;
let _propRebuildTimer = null;

// ── Filter + sort state (persists across navigation via localStorage) ─────────
const _pf = { years: new Set(), channels: new Set(), owners: new Set(), types: new Set(), countries: new Set() };
let _pSortDir = 1; // 1 = asc, -1 = desc
let _pSortKey = 'name'; // 'name' | 'type'

const PF_KEY = 'btf:prop_filters';

function loadPropFilters() {
  try {
    const d = JSON.parse(localStorage.getItem(PF_KEY) || 'null');
    if (!d) return;
    ['years', 'channels', 'owners', 'types', 'countries'].forEach(k => {
      _pf[k].clear();
      if (Array.isArray(d[k])) d[k].forEach(v => _pf[k].add(v));
    });
    if (d.sortDir) _pSortDir = d.sortDir;
    if (d.sortKey) _pSortKey = d.sortKey;
  } catch { /* ignore */ }
}

function savePropFilters() {
  try {
    localStorage.setItem(PF_KEY, JSON.stringify({
      years: [..._pf.years], channels: [..._pf.channels], owners: [..._pf.owners],
      types: [..._pf.types], countries: [..._pf.countries],
      sortDir: _pSortDir, sortKey: _pSortKey
    }));
  } catch { /* ignore */ }
}

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function previewDoc(doc) {
  const mime = doc.type || 'application/octet-stream';
  let b64;
  if (doc.path) {
    const file = await fetchGithubFile(doc.path);
    b64 = file.content.replace(/\n/g, '');
  } else {
    b64 = doc.data;
  }
  const byteChars = atob(b64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });
  const blobUrl = URL.createObjectURL(blob);
  window.open(blobUrl, '_blank');
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
}

function sanitizeName(str) {
  // Only strip path-separator characters; encodeURIComponent in uploadGithubFile handles the rest
  return str.replace(/[/\\:*?"<>|]/g, '-').trim();
}

function docIcon(type) {
  if (!type) return '\u{1F4CE}';
  if (type.startsWith('image/')) return '\u{1F5BC}';
  if (type === 'application/pdf') return '\u{1F4C4}';
  if (type.includes('word')) return '\u{1F4DD}';
  if (type.includes('excel') || type.includes('spreadsheet')) return '\u{1F4CA}';
  return '\u{1F4CE}';
}

export default {
  id: 'properties',
  label: 'Properties',
  icon: 'H',

  render(container) {
    container.appendChild(build());
  },
  refresh() {
    const c = document.getElementById('content');
    c.innerHTML = '';
    c.appendChild(build());
  },
  destroy() {}
};

function build() {
  loadPropFilters();
  const wrap = el('div', { class: 'view active' });

  const header = el('div', { class: 'section-header' },
    el('div', { class: 'card-title' }, `${listActive('properties').length} Properties`),
    el('div', { class: 'actions' },
      button('+ Add Property', { variant: 'primary', onClick: () => openForm() })
    )
  );
  wrap.appendChild(header);

  const filterBar = el('div', { class: 'flex gap-8 mb-16', style: 'flex-wrap:wrap;align-items:center' });
  wrap.appendChild(filterBar);

  const grid = el('div', { class: 'prop-grid' });
  wrap.appendChild(grid);

  rebuildPropFilters(filterBar, grid);

  return wrap;
}

// Builds (or rebuilds) the filter bar with interdependent multi-selects.
// Valid options for each filter are computed from properties that pass all
// OTHER active filters, so selecting one filter narrows the others.
function rebuildPropFilters(filterBar, grid) {
  filterBar.innerHTML = '';
  const all = listActive('properties');

  // Returns true if property p passes all filters except the one named `skip`
  const matchesExcept = (p, skip) => {
    if (skip !== 'years'     && _pf.years.size     && !_pf.years.has(p.purchaseDate?.slice(0, 4) || ''))  return false;
    if (skip !== 'channels'  && _pf.channels.size  && !_pf.channels.has(p.channel || 'company'))           return false;
    if (skip !== 'owners'    && _pf.owners.size    && !_pf.owners.has(p.owner || ''))                       return false;
    if (skip !== 'types'     && _pf.types.size     && !_pf.types.has(p.type || ''))                         return false;
    if (skip !== 'countries' && _pf.countries.size && !_pf.countries.has(p.country || ''))                  return false;
    return true;
  };
  const uniq = (arr) => [...new Set(arr)].sort();

  const validYears     = uniq(all.filter(p => matchesExcept(p, 'years'    )).map(p => p.purchaseDate?.slice(0, 4)).filter(Boolean));
  const validChannels  = uniq(all.filter(p => matchesExcept(p, 'channels' )).map(p => p.channel || 'company'));
  const validOwners    = uniq(all.filter(p => matchesExcept(p, 'owners'   )).map(p => p.owner).filter(Boolean));
  const validTypes     = uniq(all.filter(p => matchesExcept(p, 'types'    )).map(p => p.type).filter(Boolean));
  const validCountries = uniq(all.filter(p => matchesExcept(p, 'countries')).map(p => p.country).filter(Boolean));

  // Prune selections that are no longer valid given other active filters
  [..._pf.years    ].forEach(v => { if (!validYears.includes(v))    _pf.years.delete(v); });
  [..._pf.channels ].forEach(v => { if (!validChannels.includes(v)) _pf.channels.delete(v); });
  [..._pf.owners   ].forEach(v => { if (!validOwners.includes(v))   _pf.owners.delete(v); });
  [..._pf.types    ].forEach(v => { if (!validTypes.includes(v))    _pf.types.delete(v); });
  [..._pf.countries].forEach(v => { if (!validCountries.includes(v)) _pf.countries.delete(v); });
  savePropFilters();

  const onChange = () => { savePropFilters(); clearTimeout(_propRebuildTimer); _propRebuildTimer = setTimeout(() => rebuildPropFilters(filterBar, grid), 250); };

  const yearMS    = buildMultiSelect(validYears.map(y => ({ value: y, label: y })), _pf.years, 'All Years', onChange);
  const channelMS = buildMultiSelect(validChannels.map(v => ({ value: v, label: PROPERTY_CHANNELS[v] || v })), _pf.channels, 'All Channels', onChange);
  const ownerMS   = buildMultiSelect(validOwners.map(v => ({ value: v, label: getPersonName(v) })), _pf.owners, 'All Owners', onChange);
  const typeMS    = buildMultiSelect(validTypes.map(v => ({ value: v, label: PROPERTY_TYPES[v] || v })), _pf.types, 'All Types', onChange);
  const countryMS = buildMultiSelect(validCountries.map(v => ({ value: v, label: v })), _pf.countries, 'All Countries', onChange);

  const resetBtn = button('Reset Filters', {
    variant: 'sm ghost',
    onClick: () => {
      yearMS.reset(); channelMS.reset(); ownerMS.reset(); typeMS.reset(); countryMS.reset();
      _pf.years.clear(); _pf.channels.clear(); _pf.owners.clear(); _pf.types.clear(); _pf.countries.clear();
      _pSortDir = 1; _pSortKey = 'name';
      savePropFilters();
      rebuildPropFilters(filterBar, grid);
    }
  });

  const mkSortBtn = (key, label) => {
    const active = _pSortKey === key;
    const arrow  = active ? (_pSortDir > 0 ? ' ▲' : ' ▼') : ' ⇅';
    return button(label + arrow, {
      variant: active ? 'sm' : 'sm ghost',
      onClick: () => {
        if (_pSortKey === key) _pSortDir *= -1;
        else { _pSortKey = key; _pSortDir = 1; }
        savePropFilters();
        rebuildPropFilters(filterBar, grid);
      }
    });
  };

  filterBar.appendChild(yearMS);
  filterBar.appendChild(channelMS);
  filterBar.appendChild(ownerMS);
  filterBar.appendChild(typeMS);
  filterBar.appendChild(countryMS);
  filterBar.appendChild(resetBtn);
  filterBar.appendChild(el('div', { class: 'flex-1' }));
  filterBar.appendChild(mkSortBtn('name', 'Name'));
  filterBar.appendChild(mkSortBtn('type', 'Type'));
  filterBar.appendChild(mkSortBtn('revenue', 'Revenue'));
  filterBar.appendChild(mkSortBtn('roi', 'ROI'));
  renderPropGrid(grid, all);
}

// Applies active filters + sort to the property grid, replacing its contents.
function renderPropGrid(grid, preloaded) {
  grid.innerHTML = '';
  let props = preloaded || listActive('properties');

  if (_pf.years.size)     props = props.filter(p => _pf.years.has(p.purchaseDate?.slice(0, 4) || ''));
  if (_pf.channels.size)  props = props.filter(p => _pf.channels.has(p.channel || 'company'));
  if (_pf.owners.size)    props = props.filter(p => _pf.owners.has(p.owner || ''));
  if (_pf.types.size)     props = props.filter(p => _pf.types.has(p.type || ''));
  if (_pf.countries.size) props = props.filter(p => _pf.countries.has(p.country || ''));

  const year = new Date().getFullYear();
  const statsMap = new Map();
  for (const p of props) {
    statsMap.set(p.id, {
      rev: propertyRevenueEUR(p.id, { year }),
      exp: propertyExpensesEUR(p.id, { year }, { includeRenovation: false }),
      roi: propertyROI(p.id)
    });
  }

  props = [...props].sort((a, b) => {
    if (_pSortKey === 'revenue') return ((statsMap.get(a.id)?.rev ?? 0) - (statsMap.get(b.id)?.rev ?? 0)) * _pSortDir;
    if (_pSortKey === 'roi')     return ((statsMap.get(a.id)?.roi ?? 0) - (statsMap.get(b.id)?.roi ?? 0)) * _pSortDir;
    const av = _pSortKey === 'type' ? (a.type || '') : (a.name || '');
    const bv = _pSortKey === 'type' ? (b.type || '') : (b.name || '');
    return av.localeCompare(bv) * _pSortDir;
  });

  if (props.length === 0) {
    const hasFilter = _pf.years.size || _pf.channels.size || _pf.owners.size || _pf.types.size || _pf.countries.size;
    grid.appendChild(el('div', { class: 'empty' },
      el('div', { class: 'empty-icon' }, 'H'),
      hasFilter ? 'No properties match your filters.' : 'No properties yet. Add your first one.'
    ));
    return;
  }
  for (const p of props) grid.appendChild(card(p, statsMap.get(p.id)));
}

function card(p, stats) {
  const statusCss = PROPERTY_STATUSES[p.status]?.css || 'vacant';
  const rev = stats?.rev ?? propertyRevenueEUR(p.id, { year: new Date().getFullYear() });
  const roi = stats?.roi ?? propertyROI(p.id);
  const c = el('div', { class: 'prop-card' });
  c.onclick = () => openDetail(p.id, stats);
  c.appendChild(el('div', { class: 'prop-card-header' },
    el('div', {},
      el('div', { class: 'prop-card-name' }, p.name),
      el('div', { class: 'prop-card-loc' }, `${p.flag || ''} ${p.city}, ${p.country}`)
    ),
    el('span', { class: `badge ${statusCss === 'active' ? 'success' : statusCss === 'renovation' ? 'warning' : statusCss === 'sold' ? 'danger' : ''}` },
      el('span', { class: `dot ${statusCss}` }),
      PROPERTY_STATUSES[p.status]?.label || p.status
    )
  ));
  c.appendChild(el('div', { class: 'flex gap-8 mt-8' },
    el('span', { class: `badge ${p.type === 'short_term' ? 'short' : 'long'}` }, p.type === 'short_term' ? 'Short-term' : 'Long-term'),
    el('span', { class: 'badge' }, getPersonName(p.owner || 'both'))
  ));
  c.appendChild(el('div', { class: 'prop-card-stats' },
    statBox('Purchase', formatMoney(p.purchasePrice, p.currency, { maxFrac: 0 })),
    statBox('Rev YTD', formatEUR(rev)),
    statBox('ROI', `${roi.toFixed(1)}%`)
  ));
  return c;
}

function statBox(label, value) {
  return el('div', {},
    el('div', { class: 'prop-card-stat-label' }, label),
    el('div', { class: 'prop-card-stat-value num' }, value)
  );
}

export function openDetail(id, preStats) {
  selectedId = id;
  const p = byId('properties', id);
  if (!p) return;
  const year = new Date().getFullYear();
  const rev  = preStats?.rev ?? propertyRevenueEUR(id, { year });
  const exp  = preStats?.exp ?? propertyExpensesEUR(id, { year }, { includeRenovation: false });
  const reno = renovationCapexEUR({ propertyId: id });
  const roi  = preStats?.roi ?? propertyROI(id);
  const net = rev - exp;

  const body = el('div', {});
  body.appendChild(el('div', { class: 'flex gap-16 mb-16' },
    el('div', { class: 'prop-flag' }, p.flag || 'P'),
    el('div', { class: 'flex-1' },
      el('h2', {}, p.name),
      el('div', { class: 'muted', style: 'font-size:12px' }, `${p.address}, ${p.city}, ${p.country}`),
      el('div', { class: 'flex gap-8 mt-8' },
        el('span', { class: `badge ${p.status === 'active' ? 'success' : p.status === 'renovation' ? 'warning' : p.status === 'sold' ? 'danger' : ''}` }, PROPERTY_STATUSES[p.status]?.label || p.status),
        el('span', { class: `badge ${p.type === 'short_term' ? 'short' : 'long'}` }, PROPERTY_TYPES[p.type]),
        el('span', { class: 'badge' }, getPersonName(p.owner || 'both'))
      )
    )
  ));

  // Build year options from payment history for this property
  const propYears = [...new Set(
    listActivePayments().filter(pmt => pmt.propertyId === id && pmt.date).map(pmt => pmt.date.slice(0, 4))
  )].sort().reverse();
  if (!propYears.includes(String(year))) propYears.unshift(String(year));

  const yearSel = select(propYears.map(y => ({ value: y, label: y })), String(year));
  const statsGrid = el('div', { class: 'grid grid-4 mb-16' });
  const statsGrid2 = el('div', { class: 'grid grid-3 mb-16' });

  const updateStats = () => {
    const y = Number(yearSel.value);
    const r  = propertyRevenueEUR(id, { year: y });
    const ex = propertyExpensesEUR(id, { year: y }, { includeRenovation: false });
    const re = renovationCapexEUR({ propertyId: id });
    const ri = propertyROI(id);
    const n  = r - ex;
    statsGrid.innerHTML = '';
    statsGrid.appendChild(smallStat('Purchase Price', formatMoney(p.purchasePrice, p.currency, { maxFrac: 0 }), p.currency !== 'EUR' ? `${formatEUR(toEUR(p.purchasePrice, p.currency))} EUR` : null));
    statsGrid.appendChild(smallStat(`Revenue ${y}`, formatEUR(r)));
    statsGrid.appendChild(smallStat(`Expenses ${y}`, formatEUR(ex)));
    statsGrid.appendChild(smallStat(`Net ${y}`, formatEUR(n)));
    statsGrid2.innerHTML = '';
    statsGrid2.appendChild(smallStat('Mortgage Balance', formatMoney(p.mortgageAmount, p.currency, { maxFrac: 0 }), `Monthly ${formatMoney(p.mortgageMonthly, p.currency, { maxFrac: 0 })} @ ${p.mortgageRate}%`));
    statsGrid2.appendChild(smallStat('Renovation CapEx', formatEUR(re)));
    statsGrid2.appendChild(smallStat('Annual ROI', `${ri.toFixed(2)}%`));
  };
  yearSel.onchange = updateStats;
  updateStats();

  body.appendChild(el('div', { class: 'flex gap-8 mb-8', style: 'align-items:center' },
    el('span', { style: 'font-size:13px;color:var(--text-muted)' }, 'Year:'),
    yearSel
  ));
  body.appendChild(statsGrid);
  body.appendChild(statsGrid2);

  if (p.status === 'sold' && p.soldDate) {
    body.appendChild(el('div', { class: 'grid grid-3 mb-16' },
      smallStat('Sold Date', fmtDate(p.soldDate))
    ));
  }

  if ((p.vacantPeriods || []).length > 0) {
    const vpCard = el('div', { class: 'card mb-16' });
    vpCard.appendChild(el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, `Vacant Periods (${p.vacantPeriods.length})`)));
    const vpTw = el('div', { class: 'table-wrap' });
    const vpT = el('table', { class: 'table' });
    vpT.innerHTML = '<thead><tr><th>Start</th><th>End</th><th>Notes</th></tr></thead>';
    const vpTb = el('tbody');
    for (const vp of p.vacantPeriods) {
      const vptr = el('tr');
      vptr.appendChild(el('td', {}, fmtDate(vp.startDate)));
      vptr.appendChild(el('td', {}, vp.endDate ? fmtDate(vp.endDate) : 'Ongoing'));
      vptr.appendChild(el('td', { class: 'muted' }, vp.notes || ''));
      vpTb.appendChild(vptr);
    }
    vpT.appendChild(vpTb); vpTw.appendChild(vpT);
    vpCard.appendChild(vpTw);
    body.appendChild(vpCard);
  }

  if (p.type === 'short_term') {
    body.appendChild(el('div', { class: 'card mb-16' },
      el('div', { class: 'card-header' },
        el('div', { class: 'card-title' }, 'Airbnb Calendar Sync'),
        el('div', { class: 'actions' }, button('Import iCal', { variant: 'primary', onClick: () => doImportICal(p) }))
      ),
      el('div', { class: 'form-row' },
        el('label', { class: 'form-label' }, 'iCal URL (Airbnb export)'),
        input({ id: 'ical-url', value: p.airbnbCalUrl || '', placeholder: 'https://airbnb.com/calendar/ical/...' })
      )
    ));
  }

  // Vendors with rates for this property
  const propVendors = (state.db.vendors || []).filter(v => v.rates && v.rates[id] !== undefined);
  if (propVendors.length > 0) {
    const vendorCard = el('div', { class: 'card mb-16' });
    vendorCard.appendChild(el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Vendors')));
    const vGrid = el('div', { class: 'grid grid-3', style: 'padding:12px 16px' });
    for (const v of propVendors) {
      const roleMeta = VENDOR_ROLES[v.role] || { label: v.role };
      vGrid.appendChild(smallStat(v.name, formatMoney(v.rates[id], p.currency, { maxFrac: 0 }), roleMeta.label));
    }
    vendorCard.appendChild(vGrid);
    body.appendChild(vendorCard);
  }

  // Expense breakdown
  const expList = listActive('expenses').filter(e => e.propertyId === id).sort((a, b) => (b.date || '').localeCompare(a.date));
  const expTable = el('div', { class: 'card mb-16' });
  const addExpBtn = button('+ Add Expense', { variant: 'primary', onClick: () => {
    closeModal();
    const defaults = { propertyId: id, stream: p.type === 'short_term' ? 'short_term_rental' : 'long_term_rental', currency: p.currency };
    setTimeout(() => openExpenseForm(defaults, { onSave: () => openDetail(id) }), 220);
  }});
  let expShowAll = false;
  const expTitleEl = el('div', { class: 'card-title' }, 'Recent Expenses');
  const expActions = el('div', { class: 'actions' });
  expActions.appendChild(addExpBtn);
  expTable.appendChild(el('div', { class: 'card-header' }, expTitleEl, expActions));

  const renderExpenses = () => {
    const old = expTable.querySelector('.table-wrap, .empty');
    if (old) old.remove();
    const shown = expList.slice(0, expShowAll ? expList.length : 10);
    expTitleEl.textContent = `Recent Expenses${expList.length > 10 ? ` (${shown.length}/${expList.length})` : ''}`;
    const oldBtn = expActions.querySelector('.exp-show-all');
    if (oldBtn) oldBtn.remove();
    if (!expShowAll && expList.length > 10) {
      const saBtn = button(`Show all ${expList.length}`, { variant: 'sm ghost' });
      saBtn.className += ' exp-show-all';
      saBtn.onclick = () => { expShowAll = true; renderExpenses(); };
      expActions.insertBefore(saBtn, addExpBtn);
    }
    if (expList.length === 0) { expTable.appendChild(el('div', { class: 'empty' }, 'No expenses recorded')); return; }
    const tw = el('div', { class: 'table-wrap' });
    const t = el('table', { class: 'table' });
    t.innerHTML = '<thead><tr><th>Date</th><th>Category</th><th>Description</th><th class="right">Amount</th><th></th></tr></thead>';
    const tb = el('tbody');
    for (const e of shown) {
      const tr = el('tr');
      tr.appendChild(el('td', {}, fmtDate(e.date)));
      tr.appendChild(el('td', {}, el('span', { class: 'badge' }, EXPENSE_CATEGORIES[e.category]?.label || e.category)));
      tr.appendChild(el('td', {}, e.description || ''));
      tr.appendChild(el('td', { class: 'right num' }, formatMoney(e.amount, e.currency, { maxFrac: 0 })));
      const actions = el('td', { class: 'right', style: 'white-space:nowrap' });
      actions.appendChild(button('Edit', { variant: 'sm ghost', onClick: () => {
        closeModal();
        setTimeout(() => openExpenseForm(e.id, { onSave: () => openDetail(id) }), 220);
      }}));
      actions.appendChild(button('Del', { variant: 'sm ghost', onClick: async () => {
        const ok = await confirmDialog('Delete this expense?', { danger: true, okLabel: 'Delete' });
        if (!ok) return;
        restoreInventoryStock(e);
        softDelete('expenses', e.id);
        expList.splice(expList.indexOf(e), 1);
        renderExpenses();
        toast('Expense deleted', 'success');
      }}));
      tr.appendChild(actions);
      tb.appendChild(tr);
    }
    t.appendChild(tb); tw.appendChild(t); expTable.appendChild(tw);
  };
  renderExpenses();
  body.appendChild(expTable);

  // Documents
  const docsViewCard = el('div', { class: 'card mb-16' });
  const docsTitleEl = el('div', { class: 'card-title' }, `Documents (${(p.documents || []).length})`);
  docsViewCard.appendChild(el('div', { class: 'card-header' },
    docsTitleEl,
    button('Manage', { onClick: () => { closeModal(); setTimeout(() => openForm(p), 220); } })
  ));
  const dl = el('div', { class: 'doc-list' });
  const renderDetailDocList = () => {
    dl.innerHTML = '';
    const currentDocs = p.documents || [];
    docsTitleEl.textContent = `Documents (${currentDocs.length})`;
    if (currentDocs.length === 0) {
      dl.appendChild(el('div', { class: 'doc-empty' }, 'No documents attached. Use Manage to upload.'));
      return;
    }
    for (const d of currentDocs) {
      const row = el('div', { class: 'doc-row' });
      row.appendChild(el('span', { class: 'doc-icon' }, docIcon(d.type)));
      row.appendChild(el('span', { class: 'doc-name', title: d.name }, d.name));
      row.appendChild(el('span', { class: 'doc-size' }, fmtSize(d.size)));
      if (d.uploadedAt) row.appendChild(el('span', { class: 'doc-date' }, fmtDate(d.uploadedAt.slice(0, 10))));
      row.appendChild(button('Preview', { variant: 'ghost', onClick: () => previewDoc(d) }));
      if (d.path) {
        row.appendChild(button('Delete', { variant: 'ghost', onClick: async () => {
          const ok = await confirmDialog(`Delete document "${d.name}"?`, { danger: true, okLabel: 'Delete' });
          if (!ok) return;
          try { await deleteGithubFile(d.path, null, `Remove document: ${d.name}`); }
          catch (e) { toast(`Repo cleanup failed: ${e.message}`, 'warning', 5000); }
          p.documents = (p.documents || []).filter(x => x.id !== d.id);
          upsert('properties', p);
          renderDetailDocList();
        }}));
      }
      dl.appendChild(row);
    }
  };
  renderDetailDocList();
  docsViewCard.appendChild(dl);
  body.appendChild(docsViewCard);

  const editBtn = button('Edit', { onClick: () => { closeModal(); setTimeout(() => openForm(p), 220); } });
  const delBtn = button('Delete', { variant: 'danger', onClick: async () => {
    const expCount = listActive('expenses').filter(e => e.propertyId === p.id).length;
    const payCount = listActivePayments().filter(pm => pm.propertyId === p.id).length;
    const tenCount = listActive('tenants').filter(t => t.propertyId === p.id).length;
    const refs = [];
    if (expCount) refs.push(`${expCount} expense(s)`);
    if (payCount) refs.push(`${payCount} payment(s)`);
    if (tenCount) refs.push(`${tenCount} tenant(s)`);
    if (refs.length) { toast(`Cannot delete — linked records exist: ${refs.join(', ')}.`, 'danger', 5000); return; }
    const ok = await confirmDialog(`Delete property "${p.name}"?`, { danger: true, okLabel: 'Delete' });
    if (!ok) return;
    softDelete('properties', p.id);
    toast('Property deleted', 'success');
    closeModal();
    setTimeout(() => navigate('properties'),250);
  }});

  openModal({ title: 'Property Details', body, footer: [delBtn, editBtn], large: true });
}

function smallStat(label, value, sub) {
  return el('div', { class: 'kpi pad-sm' },
    el('div', { class: 'kpi-label' }, label),
    el('div', { style: 'font-size:1.15rem;font-weight:700;font-variant-numeric:tabular-nums' }, value),
    sub ? el('div', { class: 'fx-hint' }, sub) : null
  );
}

function nextMonthKey(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

function generateOwnerRentExpenses(prop, history) {
  if (!history || history.length === 0) return;
  const sorted = [...history].sort((a, b) => a.from.localeCompare(b.from));
  const startMonth = sorted[0].from.slice(0, 7);
  const nowMonth   = new Date().toISOString().slice(0, 7);
  const stream     = prop.type === 'short_term' ? 'short_term_rental' : 'long_term_rental';
  let monthKey = startMonth;
  while (monthKey <= nowMonth) {
    const applicable = [...sorted].reverse().find(e => e.from.slice(0, 7) <= monthKey);
    if (applicable) {
      const already = (state.db.expenses || []).some(e =>
        !e.deletedAt &&
        e.propertyId === prop.id &&
        e.category === 'owner_rent' &&
        (e.date || '').slice(0, 7) === monthKey
      );
      if (!already) {
        upsert('expenses', {
          id: newId('exp'),
          propertyId: prop.id,
          category: 'owner_rent',
          amount: applicable.amount,
          currency: applicable.currency || prop.currency || 'EUR',
          date: monthKey + '-01',
          description: `Owner rent — ${prop.name}`,
          stream,
          owner: prop.owner || 'both',
          accountingType: 'opex',
          costCategory: 'property_management',
          recurrence: 'recurring'
        });
      }
    }
    monthKey = nextMonthKey(monthKey);
  }
}

function openForm(existing) {
  const p = existing ? { ...existing } : {
    id: newId('prop'),
    name: '', address: '', city: '', country: '', flag: '',
    type: 'short_term', status: 'active', channel: 'company',
    bedrooms: 1, bathrooms: 1,
    purchasePrice: 0, currency: 'EUR', purchaseDate: new Date().toISOString().slice(0, 10),
    monthlyRent: 0, nightlyRate: 0,
    mortgageAmount: 0, mortgageMonthly: 0, mortgageRate: 0,
    owner: 'both', airbnbCalUrl: '', notes: ''
  };

  const body = el('div', {});
  const nameI = input({ value: p.name, placeholder: 'e.g. Barcelona Beach Apt' });
  const addressI = input({ value: p.address, placeholder: 'Street address' });
  const cityI = input({ value: p.city });
  const countryI = input({ value: p.country });
  const flagI = input({ value: p.flag, placeholder: 'ES, HU, PT...', maxlength: 4 });
  const typeS    = select(Object.entries(PROPERTY_TYPES).map(([v, l]) => ({ value: v, label: l })), p.type);
  const statusS  = select(Object.entries(PROPERTY_STATUSES).map(([v, m]) => ({ value: v, label: m.label })), p.status);
  const ownerS   = select(getPeopleOwners({ includeBoth: true }), p.owner);
  const channelS = select(Object.entries(PROPERTY_CHANNELS).map(([v, l]) => ({ value: v, label: l })), p.channel || 'company');
  const currencyS = select(CURRENCIES, p.currency);
  const purchaseI = input({ type: 'number', value: p.purchasePrice, min: 0, step: 1000 });
  const dateI = input({ type: 'date', value: p.purchaseDate });
  const rentI = input({ type: 'number', value: p.monthlyRent || 0, min: 0 });
  const payDayI = input({ type: 'number', value: p.paymentDayOfMonth || 1, min: 1, max: 28 });
  const mAmtI = input({ type: 'number', value: p.mortgageAmount, min: 0 });
  const mMoI = input({ type: 'number', value: p.mortgageMonthly, min: 0 });
  const mRateI = input({ type: 'number', value: p.mortgageRate, min: 0, step: 0.1 });
  const notesT = textarea({ placeholder: 'Notes' });
  notesT.value = p.notes || '';
  const bedsI = input({ type: 'number', value: p.bedrooms, min: 0 });
  const bathsI = input({ type: 'number', value: p.bathrooms, min: 0 });
  const icalI = input({ value: p.airbnbCalUrl || '', placeholder: 'https://airbnb.com/calendar/ical/...' });
  const soldDateI = input({ type: 'date', value: p.soldDate || '' });

  // ── Personal-LT tenant rent row ─────────────────────────────────────────────
  const ltRow   = el('div', { class: 'form-row horizontal' }, formRow('Monthly Rent', rentI), formRow('Payment Due Day (1–28)', payDayI));
  const icalRow = formRow('Airbnb iCal URL', icalI);

  // ── Owner rent history (company-channel) ────────────────────────────────────
  let pendingRentHistory = [...(p.ownerRentHistory || [])];

  const rentHistoryListEl = el('div', { style: 'padding:0 16px 8px' });
  const renderRentHistoryList = () => {
    rentHistoryListEl.innerHTML = '';
    const sorted = [...pendingRentHistory].sort((a, b) => a.from.localeCompare(b.from));
    if (sorted.length === 0) {
      rentHistoryListEl.appendChild(el('div', { style: 'font-size:13px;color:var(--text-muted);padding:4px 0' },
        'No rates configured yet. Add a rate to start generating monthly expense records.'));
      return;
    }
    for (let i = 0; i < sorted.length; i++) {
      const entry = sorted[i];
      const row = el('div', { class: 'flex gap-8', style: 'align-items:center;margin-bottom:4px' });
      row.appendChild(el('span', { style: 'font-size:13px;flex:1' },
        `From ${fmtDate(entry.from)}: ${formatMoney(entry.amount, entry.currency, { maxFrac: 0 })}/month` +
        (i === sorted.length - 1 ? ' — current' : '')
      ));
      row.appendChild(button('✕', { variant: 'sm ghost', onClick: () => {
        pendingRentHistory = pendingRentHistory.filter(x => x.id !== entry.id);
        renderRentHistoryList();
      }}));
      rentHistoryListEl.appendChild(row);
    }
  };
  renderRentHistoryList();

  const rhFromI  = el('input', { type: 'date',   class: 'input', style: 'min-width:130px' });
  const rhAmtI   = el('input', { type: 'number', class: 'input', min: '0', placeholder: 'Amount', style: 'min-width:110px' });
  const rhCurS   = select(CURRENCIES, p.currency || 'EUR');
  const rhInline = el('div', { class: 'flex gap-8', style: 'padding:4px 16px 8px;flex-wrap:wrap;align-items:center;display:none' });
  rhInline.appendChild(el('span', { style: 'font-size:12px;color:var(--text-muted)' }, 'From'));
  rhInline.appendChild(rhFromI);
  rhInline.appendChild(rhAmtI);
  rhInline.appendChild(rhCurS);
  rhInline.appendChild(button('Add', { onClick: () => {
    if (!rhFromI.value) { toast('Effective date required', 'danger'); return; }
    const amt = Number(rhAmtI.value);
    if (!amt || amt <= 0) { toast('Amount required', 'danger'); return; }
    pendingRentHistory.push({ id: newId('rrh'), amount: amt, currency: rhCurS.value, from: rhFromI.value });
    rhFromI.value = ''; rhAmtI.value = '';
    rhInline.style.display = 'none';
    renderRentHistoryList();
  }}));
  rhInline.appendChild(button('Cancel', { variant: 'ghost', onClick: () => { rhInline.style.display = 'none'; } }));

  const addRateBtn = button('+ Add Rate', { variant: 'sm', onClick: () => {
    const now = new Date();
    rhFromI.value = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString().slice(0, 10);
    rhInline.style.display = '';
  }});

  const ownerRentCard = el('div', { class: 'card mb-16' });
  ownerRentCard.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Owner Rent (paid by company)'),
    addRateBtn
  ));
  ownerRentCard.appendChild(rhInline);
  ownerRentCard.appendChild(rentHistoryListEl);
  ownerRentCard.appendChild(el('div', { style: 'padding:0 16px 10px;font-size:11px;color:var(--text-muted)' },
    'Saving generates monthly owner_rent expense records up to today. Existing records are never changed.'
  ));

  const updateTypeFields = () => {
    const isLT      = typeS.value === 'long_term';
    const isCompany = (channelS.value || 'company') === 'company';
    ownerRentCard.style.display = isCompany ? '' : 'none';
    ltRow.style.display         = !isCompany && isLT ? '' : 'none';
    icalRow.style.display       = !isLT ? '' : 'none';
  };
  typeS.onchange    = updateTypeFields;
  channelS.onchange = updateTypeFields;

  const soldDateRow = formRow('Sold Date', soldDateI);
  const updateStatusFields = () => {
    soldDateRow.style.display = statusS.value === 'sold' ? '' : 'none';
  };
  statusS.onchange = updateStatusFields;

  body.appendChild(formRow('Name', nameI));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Address', addressI), formRow('City', cityI)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Country', countryI), formRow('Flag (ISO)', flagI)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Type', typeS), formRow('Status', statusS)));
  body.appendChild(soldDateRow);
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Owner', ownerS), formRow('Channel', channelS)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Currency', currencyS), el('div', { class: 'form-row' })));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Purchase Price', purchaseI), formRow('Purchase Date', dateI)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Bedrooms', bedsI), formRow('Bathrooms', bathsI)));
  body.appendChild(ownerRentCard);
  body.appendChild(ltRow);
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Mortgage Amount', mAmtI), formRow('Monthly Payment', mMoI)));
  body.appendChild(formRow('Interest Rate %', mRateI));
  body.appendChild(icalRow);

  // Vacant periods editor
  let pendingVacantPeriods = [...(p.vacantPeriods || [])];
  const vpListEl = el('div', { style: 'padding:0 16px 8px' });
  const renderVPList = () => {
    vpListEl.innerHTML = '';
    if (pendingVacantPeriods.length === 0) {
      vpListEl.appendChild(el('div', { class: 'muted', style: 'font-size:13px;padding:4px 0' }, 'No vacant periods added'));
      return;
    }
    for (const vp of pendingVacantPeriods) {
      const vpRow = el('div', { class: 'flex gap-8', style: 'align-items:center;margin-bottom:4px' });
      vpRow.appendChild(el('span', { style: 'font-size:13px;flex:1' },
        `${fmtDate(vp.startDate)} – ${vp.endDate ? fmtDate(vp.endDate) : 'ongoing'}${vp.notes ? ' · ' + vp.notes : ''}`
      ));
      vpRow.appendChild(button('✕', { variant: 'sm ghost', onClick: () => {
        pendingVacantPeriods = pendingVacantPeriods.filter(x => x !== vp);
        renderVPList();
      }}));
      vpListEl.appendChild(vpRow);
    }
  };
  renderVPList();
  const vpStartI = el('input', { type: 'date', class: 'input', style: 'min-width:130px' });
  const vpEndI   = el('input', { type: 'date', class: 'input', style: 'min-width:130px' });
  const vpNotesI = el('input', { type: 'text',  class: 'input', placeholder: 'Notes (optional)', style: 'flex:1;min-width:100px' });
  const addVPBtn = button('Add', { onClick: () => {
    if (!vpStartI.value) { toast('Start date is required', 'danger'); return; }
    pendingVacantPeriods.push({ startDate: vpStartI.value, endDate: vpEndI.value || '', notes: vpNotesI.value.trim() });
    vpStartI.value = ''; vpEndI.value = ''; vpNotesI.value = '';
    renderVPList();
  }});
  const vpCard = el('div', { class: 'card mb-16' });
  vpCard.appendChild(el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Vacant Periods')));
  const vpAddRow = el('div', { class: 'flex gap-8', style: 'padding:8px 16px 4px;flex-wrap:wrap;align-items:center' });
  vpAddRow.appendChild(el('span', { style: 'font-size:12px;color:var(--text-muted)' }, 'Start'));
  vpAddRow.appendChild(vpStartI);
  vpAddRow.appendChild(el('span', { style: 'font-size:12px;color:var(--text-muted)' }, 'End'));
  vpAddRow.appendChild(vpEndI);
  vpAddRow.appendChild(vpNotesI);
  vpAddRow.appendChild(addVPBtn);
  vpCard.appendChild(vpAddRow);
  vpCard.appendChild(vpListEl);
  body.appendChild(vpCard);

  // Documents upload
  let pendingDocs = [...(p.documents || [])];
  const fileInput = el('input', {
    type: 'file',
    accept: '.pdf,.jpg,.jpeg,.png,.gif,.doc,.docx,.xls,.xlsx',
    multiple: true,
    style: 'display:none'
  });
  const docListEl = el('div', { class: 'doc-list', style: 'margin-top:8px' });
  const renderDocList = () => {
    docListEl.innerHTML = '';
    if (pendingDocs.length === 0) {
      docListEl.appendChild(el('div', { class: 'doc-empty' }, 'No documents yet.'));
      return;
    }
    for (const d of pendingDocs) {
      const row = el('div', { class: 'doc-row' });
      row.appendChild(el('span', { class: 'doc-icon' }, docIcon(d.type)));
      row.appendChild(el('span', { class: 'doc-name', title: d.name }, d.name));
      row.appendChild(el('span', { class: 'doc-size' }, fmtSize(d.size)));
      row.appendChild(el('button', {
        class: 'btn ghost sm',
        type: 'button',
        title: 'Remove',
        onClick: async () => {
          if (d.path) {
            try { await deleteGithubFile(d.path, null, `Remove document: ${d.name}`); }
            catch (e) { toast(`Repo cleanup failed: ${e.message}`, 'warning', 5000); }
          }
          pendingDocs = pendingDocs.filter(x => x.id !== d.id);
          renderDocList();
        }
      }, '✕'));
      docListEl.appendChild(row);
    }
  };
  renderDocList();
  const dropZone = el('div', { class: 'doc-drop-zone' }, 'Drop files here or click to browse');
  dropZone.onclick = () => fileInput.click();
  dropZone.ondragover = e => { e.preventDefault(); dropZone.classList.add('dragover'); };
  dropZone.ondragleave = () => dropZone.classList.remove('dragover');
  dropZone.ondrop = e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    for (const file of [...e.dataTransfer.files]) {
      pendingDocs.push({ id: newId('doc'), name: file.name, type: file.type, size: file.size, uploadedAt: new Date().toISOString(), _file: file });
    }
    renderDocList();
  };
  fileInput.onchange = () => {
    for (const file of [...fileInput.files]) {
      pendingDocs.push({ id: newId('doc'), name: file.name, type: file.type, size: file.size, uploadedAt: new Date().toISOString(), _file: file });
    }
    renderDocList();
    fileInput.value = '';
  };
  const docsCard = el('div', { class: 'card mb-16' });
  docsCard.appendChild(fileInput);
  docsCard.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Documents'),
    button('+ Upload', { variant: 'primary', onClick: () => fileInput.click() })
  ));
  docsCard.appendChild(dropZone);
  docsCard.appendChild(docListEl);
  body.appendChild(docsCard);

  body.appendChild(formRow('Notes', notesT));
  updateTypeFields();
  updateStatusFields();

  const saveBtn = button('Save', { variant: 'primary', onClick: async () => {
    if (!nameI.value.trim()) { toast('Name is required', 'danger'); return; }
    const propName = nameI.value.trim();
    const safePropName = sanitizeName(propName);

    // Upload any pending new files to GitHub; keep metadata only in db.json
    const docsToSave = [];
    for (const d of pendingDocs) {
      if (d._file) {
        const safeFileName = sanitizeName(d.name);
        const repoPath = `Properties/${safePropName}/${safeFileName}`;
        try {
          const b64 = await readFileAsBase64(d._file);
          await uploadGithubFile(repoPath, b64, `Upload document: ${d.name}`);
          docsToSave.push({ id: d.id, name: d.name, type: d.type, size: d.size, uploadedAt: d.uploadedAt, path: repoPath, propertyId: p.id });
        } catch (e) {
          toast(`Failed to upload ${d.name}: ${e.message}`, 'danger', 6000);
          return;
        }
      } else {
        // Already uploaded (or legacy base64 doc) — keep as-is, strip transient _file
        const { _file, ...rest } = d;
        docsToSave.push(rest);
      }
    }

    Object.assign(p, {
      name: propName,
      address: addressI.value.trim(),
      city: cityI.value.trim(),
      country: countryI.value.trim(),
      flag: flagI.value.trim().toUpperCase(),
      type: typeS.value,
      status: statusS.value,
      owner: ownerS.value,
      channel: channelS.value || 'company',
      currency: currencyS.value,
      purchasePrice: Number(purchaseI.value) || 0,
      purchaseDate: dateI.value,
      bedrooms: Number(bedsI.value) || 0,
      bathrooms: Number(bathsI.value) || 0,
      monthlyRent: (channelS.value || 'company') !== 'company' ? (Number(rentI.value) || 0) : 0,
      paymentDayOfMonth: Number(payDayI.value) || 1,
      ownerRentHistory: (channelS.value || 'company') === 'company' ? pendingRentHistory : [],
      mortgageAmount: Number(mAmtI.value) || 0,
      mortgageMonthly: Number(mMoI.value) || 0,
      mortgageRate: Number(mRateI.value) || 0,
      airbnbCalUrl: icalI.value.trim(),
      notes: notesT.value.trim(),
      soldDate: soldDateI.value,
      vacantPeriods: pendingVacantPeriods,
      documents: docsToSave
    });
    // Soft-delete unpaid payments within vacant periods (keep paid history intact)
    if (pendingVacantPeriods.length > 0) {
      for (const pmt of (state.db.payments || [])) {
        if (pmt.propertyId !== p.id || pmt.status === 'paid' || pmt.deletedAt) continue;
        const d = pmt.date?.slice(0, 10) || '';
        if (pendingVacantPeriods.some(vp => vp.startDate && d >= vp.startDate && d <= (vp.endDate || '9999-12-31'))) {
          removeReservationExpenses(pmt);
          softDelete('payments', pmt.id);
        }
      }
    }
    upsert('properties', p);
    if ((channelS.value || 'company') === 'company' && pendingRentHistory.length > 0) {
      generateOwnerRentExpenses(p, pendingRentHistory);
    }
    toast(existing ? 'Property updated' : 'Property added', 'success');
    closeModal();
    setTimeout(() => navigate('properties'),200);
  }});
  const cancelBtn = button('Cancel', { onClick: closeModal });

  openModal({ title: existing ? 'Edit Property' : 'New Property', body, footer: [cancelBtn, saveBtn], large: true });
}

async function doImportICal(prop) {
  const urlEl = document.getElementById('ical-url');
  const url = urlEl ? urlEl.value.trim() : prop.airbnbCalUrl;
  if (!url) { toast('Enter iCal URL', 'warning'); return; }
  try {
    toast('Fetching calendar...', 'info');
    const text = await fetchICal(url);
    const events = parseICal(text);
    let added = 0;
    const existingIcal = listActivePayments().filter(p => p.propertyId === prop.id && p.source === 'airbnb');
    for (const ev of events) {
      if (!ev.start || !ev.end) continue;
      const n = nights(ev.start, ev.end);
      if (n <= 0) continue;
      const amount = n * (prop.nightlyRate || 0);
      // avoid duplicates
      if (existingIcal.some(p => p.date === ev.start && p.notes?.includes(ev.uid || ''))) continue;
      const pay = {
        id: newId('pay'),
        propertyId: prop.id,
        amount,
        currency: prop.currency,
        date: ev.start,
        type: 'rental',
        status: ev.start > new Date().toISOString().slice(0, 10) ? 'pending' : 'paid',
        source: 'airbnb',
        stream: 'short_term_rental',
        notes: `iCal: ${n} nights${ev.uid ? ' / ' + ev.uid : ''}`
      };
      upsert('payments', pay);
      added++;
    }
    prop.airbnbCalUrl = url;
    upsert('properties', prop);
    toast(`Imported ${added} booking(s)`, 'success');
    closeModal();
    setTimeout(() => navigate('properties'),200);
  } catch (e) {
    toast(`iCal import failed: ${e.message}`, 'danger', 5000);
  }
}
