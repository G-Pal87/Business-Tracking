// Expenses module
import { state } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, select, selVals, input, formRow, textarea, button, fmtDate, today, attachSortFilter, drillDownModal, buildMultiSelect } from '../core/ui.js';
import { upsert, softDelete, listActive, byId, newId, formatMoney, formatEUR, toEUR, resolveExpenseFields } from '../core/data.js';
import * as charts from '../core/charts.js';
import { CURRENCIES, EXPENSE_CATEGORIES, ACCOUNTING_TYPES, COST_CATEGORIES, RECURRENCE_TYPES } from '../core/config.js';
import { navigate } from '../core/router.js';

export default {
  id: 'expenses',
  label: 'Expenses',
  icon: 'E',
  render(container) { container.appendChild(build()); },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); },
  destroy() { charts.destroyAll(); }
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

function restoreInventoryStock(expense) {
  if (!expense.inventoryItemId || !expense.inventoryQty) return;
  const item = byId('inventory', expense.inventoryItemId);
  if (item) { upsert('inventory', { ...item, stock: item.stock + expense.inventoryQty }); }
}

function build() {
  charts.destroyAll();

  const wrap = el('div', { class: 'view active' });

  wrap.appendChild(el('div', { class: 'grid grid-2' },
    el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'By Category')),
      el('div', { class: 'chart-wrap' }, el('canvas', { id: 'chart-exp-cat' }))
    ),
    el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'By Property')),
      el('div', { class: 'chart-wrap' }, el('canvas', { id: 'chart-exp-prop' }))
    )
  ));

  const filterBar = el('div', { class: 'flex gap-8 mb-16 mt-24', style: 'flex-wrap:wrap' });

  const propFilter           = new Set();
  const catFilter            = new Set();
  const accountingTypeFilter = new Set();
  const recurrenceFilter     = new Set();

  const propMS           = buildMultiSelect(listActive('properties').map(p => ({ value: p.id, label: p.name })), propFilter, 'All Properties', () => renderAll());
  const catMS            = buildMultiSelect(Object.entries(EXPENSE_CATEGORIES).map(([v, m]) => ({ value: v, label: m.label })), catFilter, 'All Expenses', () => renderTable());
  const accountingTypeMS = buildMultiSelect(Object.entries(ACCOUNTING_TYPES).map(([v, m]) => ({ value: v, label: m.label })), accountingTypeFilter, 'All Types', () => renderAll());
  const recurrenceMS     = buildMultiSelect(Object.entries(RECURRENCE_TYPES).map(([v, m]) => ({ value: v, label: m.label })), recurrenceFilter, 'All Recurrence', () => renderTable());

  let selected = new Set();

  const deleteSelBtn = button('', { variant: 'danger', onClick: async () => {
    const count = selected.size;
    if (!count) return;
    const ok = await confirmDialog(`Delete ${count} expense(s)? This cannot be undone.`, { danger: true, okLabel: `Delete ${count}` });
    if (!ok) return;
    for (const id of [...selected]) {
      const exp = listActive('expenses').find(e => e.id === id);
      if (exp) restoreInventoryStock(exp);
      softDelete('expenses', id);
    }
    selected.clear();
    toast(`Deleted ${count} expense(s)`, 'success');
    renderTable();
  }});
  deleteSelBtn.style.display = 'none';

  filterBar.appendChild(propMS);
  filterBar.appendChild(catMS);
  filterBar.appendChild(accountingTypeMS);
  filterBar.appendChild(recurrenceMS);
  filterBar.appendChild(el('div', { class: 'flex-1' }));
  filterBar.appendChild(deleteSelBtn);
  filterBar.appendChild(button('+ Add Expense', { variant: 'primary', onClick: () => openForm() }));
  wrap.appendChild(filterBar);

  const tableWrap = el('div', { class: 'table-wrap' });
  wrap.appendChild(tableWrap);
  attachSortFilter(tableWrap);

  const syncDeleteBtn = () => {
    if (selected.size > 0) {
      deleteSelBtn.textContent = `Delete ${selected.size} Selected`;
      deleteSelBtn.style.display = '';
    } else {
      deleteSelBtn.style.display = 'none';
    }
  };

  const renderTable = () => {
    selected.clear();
    syncDeleteBtn();
    tableWrap.innerHTML = '';

    let rows = [...listActive('expenses')];
    if (propFilter.size > 0)           rows = rows.filter(r => propFilter.has(r.propertyId));
    if (catFilter.size > 0)            rows = rows.filter(r => catFilter.has(r.category));
    if (accountingTypeFilter.size > 0) rows = rows.filter(r => accountingTypeFilter.has(resolveExpenseFields(r).accountingType));
    if (recurrenceFilter.size > 0)     rows = rows.filter(r => recurrenceFilter.has(resolveExpenseFields(r).recurrence));
    rows.sort((a, b) => (b.date || '').localeCompare(a.date));

    if (rows.length === 0) {
      tableWrap.appendChild(el('div', { class: 'empty' }, 'No expenses'));
      return;
    }

    const t = el('table', { class: 'table' });

    const selectAllChk = el('input', { type: 'checkbox', style: 'cursor:pointer' });
    const htr = el('tr', {});
    const chkTh = el('th', { style: 'width:36px' }); chkTh.appendChild(selectAllChk);
    htr.appendChild(chkTh);
    ['Date', 'Property', 'Category', 'Description', 'Vendor'].forEach(h => htr.appendChild(el('th', {}, h)));
    htr.appendChild(el('th', { class: 'right' }, 'Amount'));
    htr.appendChild(el('th', { class: 'right' }, 'EUR'));
    htr.appendChild(el('th', {}));
    const thead = el('thead', {}); thead.appendChild(htr); t.appendChild(thead);

    const tb = el('tbody');
    const rowChks = [];

    for (const r of rows) {
      const prop = byId('properties', r.propertyId);
      const cat  = EXPENSE_CATEGORIES[r.category];

      const chk = el('input', { type: 'checkbox', style: 'cursor:pointer' });
      rowChks.push(chk);
      chk.onchange = () => {
        if (chk.checked) selected.add(r.id); else selected.delete(r.id);
        const n = rowChks.filter(c => c.checked).length;
        selectAllChk.indeterminate = n > 0 && n < rows.length;
        selectAllChk.checked = n === rows.length;
        syncDeleteBtn();
      };

      const tr = el('tr');
      const chkTd = el('td', { style: 'width:36px' }); chkTd.appendChild(chk);
      tr.appendChild(chkTd);
      tr.appendChild(el('td', {}, fmtDate(r.date)));
      tr.appendChild(el('td', {}, prop?.name || '-'));
      const catCell = el('td', {});
      catCell.appendChild(el('span', { class: 'badge ' + (r.category === 'renovation' ? 'warning' : '') }, cat?.label || r.category));
      if (resolveExpenseFields(r).accountingType === 'capex' && r.category !== 'renovation')
        catCell.appendChild(el('span', { class: 'badge warning', style: 'margin-left:4px;font-size:10px' }, 'CapEx'));
      tr.appendChild(catCell);
      const descCell = el('td', {});
      if (r.recurringGroupId) descCell.appendChild(el('span', { class: 'badge', style: 'margin-right:4px;font-size:10px' }, '↻'));
      descCell.appendChild(document.createTextNode(r.description || ''));
      tr.appendChild(descCell);
      tr.appendChild(el('td', {}, r.vendorId ? (byId('vendors', r.vendorId)?.name || r.vendor || '') : (r.vendor || '')));
      tr.appendChild(el('td', { class: 'right num' }, formatMoney(r.amount, r.currency, { maxFrac: 0 })));
      tr.appendChild(el('td', { class: 'right num muted' }, r.currency === 'EUR' ? '' : formatEUR(toEUR(r.amount, r.currency))));
      const actions = el('td', { class: 'right' });
      actions.appendChild(button('Edit', { variant: 'sm ghost', onClick: () => openForm(r) }));
      actions.appendChild(button('Del', { variant: 'sm ghost', onClick: async () => {
        const ok = await confirmDialog('Delete expense?', { danger: true, okLabel: 'Delete' });
        if (ok) { restoreInventoryStock(r); softDelete('expenses', r.id); toast('Deleted', 'success'); renderTable(); }
      }}));
      tr.appendChild(actions);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    tableWrap.appendChild(t);

    selectAllChk.onchange = () => {
      rowChks.forEach(c => { c.checked = selectAllChk.checked; });
      selectAllChk.indeterminate = false;
      if (selectAllChk.checked) rows.forEach(r => selected.add(r.id)); else selected.clear();
      syncDeleteBtn();
    };

    const totalEUR = rows.reduce((s, r) => s + toEUR(r.amount, r.currency), 0);
    const capexEUR = rows.filter(r => resolveExpenseFields(r).accountingType === 'capex').reduce((s, r) => s + toEUR(r.amount, r.currency), 0);
    tableWrap.appendChild(el('div', { class: 'flex justify-between', style: 'padding:14px 16px;border-top:1px solid var(--border);font-size:13px' },
      el('span', { class: 'muted' }, `${rows.length} expense(s) · CapEx: ${formatEUR(capexEUR)}`),
      el('strong', { class: 'num' }, `Total: ${formatEUR(totalEUR)}`)
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
    { key: 'vendor',        label: 'Vendor' },
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
        vendor:        r.vendorId ? (byId('vendors', r.vendorId)?.name || r.vendor || '—') : (r.vendor || '—'),
        eur:           toEUR(r.amount, r.currency),
      };
    })
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // Dashboard: respects property + accountingType filters; category/recurrence stay for table only
  const renderDash = () => {
    let bkRows = listActive('expenses');
    if (propFilter.size > 0)           bkRows = bkRows.filter(r => propFilter.has(r.propertyId));
    if (accountingTypeFilter.size > 0) bkRows = bkRows.filter(r => accountingTypeFilter.has(resolveExpenseFields(r).accountingType));

    // By Cost Category doughnut (groups by resolved costCategory for correct OpEx/CapEx separation)
    const byCostCat = new Map();
    for (const r of bkRows) {
      const k = resolveExpenseFields(r).costCategory;
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
          toDrillRows(bkRows.filter(r => resolveExpenseFields(r).costCategory === key)),
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

  const renderAll = () => { renderTable(); renderDash(); };

  renderTable();
  // Defer chart render until canvas elements are in the DOM
  requestAnimationFrame(() => renderDash());

  return wrap;
}

export function openExpenseForm(defaults = {}) {
  openForm(null, defaults);
}

function openForm(existing, defaults = {}) {
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
  const propS = select((state.db.properties || []).map(p => ({ value: p.id, label: p.name })), r.propertyId);
  const catS = select(Object.entries(EXPENSE_CATEGORIES).map(([v, m]) => ({ value: v, label: m.label })), r.category);
  const resolved = resolveExpenseFields(r);
  const accountingTypeS = select(Object.entries(ACCOUNTING_TYPES).map(([v, m]) => ({ value: v, label: m.label })), resolved.accountingType);
  const costCategoryS   = select(Object.entries(COST_CATEGORIES).map(([v, m]) => ({ value: v, label: m.label })), resolved.costCategory);
  const recurrenceS     = select(Object.entries(RECURRENCE_TYPES).map(([v, m]) => ({ value: v, label: m.label })), resolved.recurrence);
  const vendorOpts = [{ value: '', label: '— No vendor —' }, ...(state.db.vendors || []).map(v => ({ value: v.id, label: v.name }))];
  const vendorS = select(vendorOpts, r.vendorId || '');
  const amountI = input({ type: 'number', value: r.amount, min: 0, step: 0.01 });
  const currencyS = select(CURRENCIES, r.currency);
  const dateI = input({ type: 'date', value: r.date });
  const descT = textarea({ placeholder: 'Description' });
  descT.value = r.description || '';

  const invItemOpts = [
    { value: '', label: '— Select item —' },
    ...(state.db.inventory || []).map(item => {
      const avail = item.stock + (existing?.inventoryItemId === item.id ? (existing.inventoryQty || 0) : 0);
      return { value: item.id, label: `${item.name} (avail: ${avail})` };
    })
  ];
  const invItemS = select(invItemOpts, r.inventoryItemId || '');
  const invQtyI  = input({ type: 'number', value: r.inventoryQty || 1, min: 1, step: 1 });
  const invRow   = el('div', { class: 'form-row horizontal' }, formRow('Item', invItemS), formRow('Qty', invQtyI));

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

  body.appendChild(formRow('Property', propS));
  body.appendChild(formRow('Category', catS));
  body.appendChild(accountingTypeRow);
  body.appendChild(invRow);
  const vendorRow = formRow('Vendor', vendorS);
  body.appendChild(vendorRow);
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

  const autoFillAmount = () => {
    if (catS.value === 'inventory') return;
    if (Number(amountI.value) > 0) return;
    const prop = byId('properties', propS.value);
    if (!prop) return;
    if (vendorS.value) {
      const vendor = byId('vendors', vendorS.value);
      if (vendor?.rates?.[prop.id]) { amountI.value = vendor.rates[prop.id]; return; }
    }
    const cat = catS.value;
    if (cat === 'cleaning' && prop.cleaningFee) amountI.value = prop.cleaningFee;
    else if (cat === 'electricity' && prop.monthlyElectricity) amountI.value = prop.monthlyElectricity;
    else if (cat === 'water' && prop.monthlyWater) amountI.value = prop.monthlyWater;
  };

  const syncInventoryAmount = () => {
    const item = byId('inventory', invItemS.value);
    if (!item) return;
    amountI.value = (item.unitPrice * (Number(invQtyI.value) || 1)).toFixed(2);
    currencyS.value = item.currency;
  };

  const syncInventoryRow = () => {
    const isInv = catS.value === 'inventory';
    invRow.style.display    = isInv ? '' : 'none';
    vendorRow.style.display = isInv ? 'none' : '';
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
      costCategoryS.value = resolveExpenseFields({ category: catS.value }).costCategory;
    }
    syncAccountingTypeRow();
    syncInventoryRow();
    if (catS.value === 'inventory') syncInventoryAmount();
    else autoFillAmount();
  };
  vendorS.onchange = autoFillAmount;
  propS.onchange = () => {
    const p = byId('properties', propS.value);
    if (p) { currencyS.value = p.currency; autoFillAmount(); }
  };
  invItemS.onchange = syncInventoryAmount;
  invQtyI.oninput   = syncInventoryAmount;

  const save = button('Save', { variant: 'primary', onClick: () => {
    if (!propS.value) { toast('Select property', 'danger'); return; }

    if (catS.value === 'inventory') {
      const itemId = invItemS.value;
      const qty    = Number(invQtyI.value) || 0;
      if (!itemId) { toast('Select an inventory item', 'danger'); return; }
      if (qty <= 0) { toast('Quantity must be > 0', 'danger'); return; }
      const item = byId('inventory', itemId);
      if (!item) { toast('Item not found', 'danger'); return; }
      let available = item.stock;
      if (existing?.inventoryItemId === itemId) available += (existing.inventoryQty || 0);
      if (qty > available) { toast(`Insufficient stock. Available: ${available}`, 'danger'); return; }
      if (existing?.inventoryItemId && existing.inventoryItemId !== itemId) {
        const old = byId('inventory', existing.inventoryItemId);
        if (old) { old.stock += (existing.inventoryQty || 0); upsert('inventory', old); }
      }
      item.stock = available - qty;
      upsert('inventory', item);
      r.inventoryItemId = itemId;
      r.inventoryQty    = qty;
    } else {
      if (existing?.inventoryItemId) {
        const old = byId('inventory', existing.inventoryItemId);
        if (old) { old.stock += (existing.inventoryQty || 0); upsert('inventory', old); }
      }
      r.inventoryItemId = '';
      r.inventoryQty    = 0;
    }

    if (Number(amountI.value) <= 0) { toast('Amount required', 'danger'); return; }
    const selectedVendor = vendorS.value ? byId('vendors', vendorS.value) : null;
    const prop = byId('properties', propS.value);
    const autoStream = prop?.type === 'short_term' ? 'short_term_rental'
      : prop?.type === 'long_term' ? 'long_term_rental'
      : r.stream || 'short_term_rental';
    Object.assign(r, {
      propertyId:    propS.value,
      category:      catS.value,
      accountingType: catS.value === 'renovation' ? 'capex' : accountingTypeS.value,
      costCategory:   catS.value === 'renovation' ? 'renovation' : costCategoryS.value,
      recurrence:    recurrenceS.value,
      amount:        Number(amountI.value),
      currency:      currencyS.value,
      date:          dateI.value,
      vendorId:      vendorS.value || '',
      vendor:        selectedVendor?.name || r.vendor || '',
      description:   descT.value.trim(),
      stream:        autoStream
    });

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
    } else {
      upsert('expenses', r);
      toast(existing ? 'Expense updated' : 'Expense added', 'success');
    }
    closeModal();
    setTimeout(() => navigate('expenses'), 200);
  }});
  const cancel = button('Cancel', { onClick: closeModal });
  openModal({ title: existing ? 'Edit Expense' : 'New Expense', body, footer: [cancel, save] });
}
