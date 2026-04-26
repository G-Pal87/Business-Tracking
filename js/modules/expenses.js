// Expenses module
import { state } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, select, selVals, input, formRow, textarea, button, fmtDate, today } from '../core/ui.js';
import { upsert, remove, byId, newId, formatMoney, formatEUR, toEUR, groupByCategory } from '../core/data.js';
import * as charts from '../core/charts.js';
import { CURRENCIES, EXPENSE_CATEGORIES, STREAMS } from '../core/config.js';
import { navigate } from '../core/router.js';

export default {
  id: 'expenses',
  label: 'Expenses',
  icon: 'E',
  render(container) { container.appendChild(build()); charts.destroyAll(); renderBreakdown(); },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); renderBreakdown(); },
  destroy() { charts.destroyAll(); }
};

function restoreInventoryStock(expense) {
  if (!expense.inventoryItemId || !expense.inventoryQty) return;
  const item = byId('inventory', expense.inventoryItemId);
  if (item) { item.stock += expense.inventoryQty; upsert('inventory', item); }
}

function build() {
  const wrap = el('div', { class: 'view active' });

  wrap.appendChild(el('div', { class: 'grid grid-2' },
    el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'By Category (all time)')),
      el('div', { class: 'chart-wrap' }, el('canvas', { id: 'chart-exp-cat' }))
    ),
    el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'By Property (all time)')),
      el('div', { class: 'chart-wrap' }, el('canvas', { id: 'chart-exp-prop' }))
    )
  ));

  const filterBar = el('div', { class: 'flex gap-8 mb-16 mt-24', style: 'flex-wrap:wrap' });
  const propSel   = select([{ value: 'all', label: 'All Properties' }, ...(state.db.properties || []).map(p => ({ value: p.id, label: p.name }))], 'all');
  const catSel    = select([{ value: 'all', label: 'All expenses' }, ...Object.entries(EXPENSE_CATEGORIES).map(([v, m]) => ({ value: v, label: m.label }))], 'all');
  const streamSel = select([{ value: 'all', label: 'All rental types' }, ...Object.entries(STREAMS).filter(([k]) => k.includes('rental')).map(([v, m]) => ({ value: v, label: m.short }))], 'all');

  let selected = new Set();

  const deleteSelBtn = button('', { variant: 'danger', onClick: async () => {
    const count = selected.size;
    if (!count) return;
    const ok = await confirmDialog(`Delete ${count} expense(s)? This cannot be undone.`, { danger: true, okLabel: `Delete ${count}` });
    if (!ok) return;
    for (const id of [...selected]) {
      const exp = (state.db.expenses || []).find(e => e.id === id);
      if (exp) restoreInventoryStock(exp);
      remove('expenses', id);
    }
    selected.clear();
    toast(`Deleted ${count} expense(s)`, 'success');
    renderTable();
  }});
  deleteSelBtn.style.display = 'none';

  filterBar.appendChild(propSel);
  filterBar.appendChild(catSel);
  filterBar.appendChild(streamSel);
  filterBar.appendChild(el('div', { class: 'flex-1' }));
  filterBar.appendChild(deleteSelBtn);
  filterBar.appendChild(button('+ Add Expense', { variant: 'primary', onClick: () => openForm() }));
  wrap.appendChild(filterBar);

  const tableWrap = el('div', { class: 'table-wrap' });
  wrap.appendChild(tableWrap);

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

    let rows = [...(state.db.expenses || [])];
    if (propSel.value !== 'all')   rows = rows.filter(r => r.propertyId === propSel.value);
    if (catSel.value !== 'all')    rows = rows.filter(r => r.category === catSel.value);
    if (streamSel.value !== 'all') rows = rows.filter(r => r.stream === streamSel.value);
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
      tr.appendChild(el('td', {}, el('span', { class: 'badge ' + (r.category === 'renovation' ? 'warning' : '') }, cat?.label || r.category)));
      tr.appendChild(el('td', {}, r.description || ''));
      tr.appendChild(el('td', {}, r.vendorId ? (byId('vendors', r.vendorId)?.name || r.vendor || '') : (r.vendor || '')));
      tr.appendChild(el('td', { class: 'right num' }, formatMoney(r.amount, r.currency, { maxFrac: 0 })));
      tr.appendChild(el('td', { class: 'right num muted' }, r.currency === 'EUR' ? '' : formatEUR(toEUR(r.amount, r.currency))));
      const actions = el('td', { class: 'right' });
      actions.appendChild(button('Edit', { variant: 'sm ghost', onClick: () => openForm(r) }));
      actions.appendChild(button('Del', { variant: 'sm ghost', onClick: async () => {
        const ok = await confirmDialog('Delete expense?', { danger: true, okLabel: 'Delete' });
        if (ok) { restoreInventoryStock(r); remove('expenses', r.id); toast('Deleted', 'success'); renderTable(); }
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
    const renoEUR  = rows.filter(r => r.category === 'renovation').reduce((s, r) => s + toEUR(r.amount, r.currency), 0);
    tableWrap.appendChild(el('div', { class: 'flex justify-between', style: 'padding:14px 16px;border-top:1px solid var(--border);font-size:13px' },
      el('span', { class: 'muted' }, `${rows.length} expense(s) . Renovation: ${formatEUR(renoEUR)}`),
      el('strong', { class: 'num' }, `Total: ${formatEUR(totalEUR)}`)
    ));
  };

  propSel.onchange = renderTable;
  catSel.onchange  = renderTable;
  streamSel.onchange = renderTable;
  renderTable();
  return wrap;
}

function renderBreakdown() {
  // By category
  const rows = state.db.expenses || [];
  const byCat = groupByCategory(rows);
  const catLabels = [], catData = [], catColors = [];
  for (const [k, m] of Object.entries(EXPENSE_CATEGORIES)) {
    if (!byCat.has(k)) continue;
    catLabels.push(m.label);
    catData.push(Math.round(byCat.get(k)));
    catColors.push(m.color);
  }
  charts.doughnut('chart-exp-cat', { labels: catLabels, data: catData, colors: catColors });

  // By property
  const byProp = new Map();
  for (const r of rows) {
    const eur = toEUR(r.amount, r.currency);
    byProp.set(r.propertyId, (byProp.get(r.propertyId) || 0) + eur);
  }
  const propLabels = [], propData = [], propColors = ['#6366f1', '#8b5cf6', '#14b8a6', '#ec4899', '#f59e0b', '#3b82f6'];
  let i = 0;
  for (const [id, val] of [...byProp.entries()].sort((a, b) => b[1] - a[1])) {
    const p = byId('properties', id);
    propLabels.push(p?.name || 'Unknown');
    propData.push(Math.round(val));
    i++;
  }
  charts.bar('chart-exp-prop', {
    labels: propLabels,
    datasets: [{ label: 'EUR', data: propData, backgroundColor: propColors }],
    horizontal: true
  });
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
  const vendorOpts = [{ value: '', label: '— No vendor —' }, ...(state.db.vendors || []).map(v => ({ value: v.id, label: v.name }))];
  const vendorS = select(vendorOpts, r.vendorId || '');
  const amountI = input({ type: 'number', value: r.amount, min: 0, step: 0.01 });
  const currencyS = select(CURRENCIES, r.currency);
  const dateI = input({ type: 'date', value: r.date });
  const descT = textarea({ placeholder: 'Description' });
  descT.value = r.description || '';
  const streamS = select(Object.entries(STREAMS).filter(([k]) => k.includes('rental')).map(([v, m]) => ({ value: v, label: m.short })), r.stream);

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

  body.appendChild(formRow('Property', propS));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Category', catS), formRow('Stream', streamS)));
  body.appendChild(invRow);
  const vendorRow = formRow('Vendor', vendorS);
  body.appendChild(vendorRow);
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Amount', amountI), formRow('Currency', currencyS)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Date', dateI)));
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
    invRow.style.display   = isInv ? '' : 'none';
    vendorRow.style.display = isInv ? 'none' : '';
  };
  syncInventoryRow();

  catS.onchange = () => {
    syncInventoryRow();
    if (catS.value === 'inventory') syncInventoryAmount();
    else autoFillAmount();
  };
  vendorS.onchange = autoFillAmount;
  propS.onchange = () => {
    const p = byId('properties', propS.value);
    if (p) {
      streamS.value = p.type === 'short_term' ? 'short_term_rental' : 'long_term_rental';
      currencyS.value = p.currency;
      autoFillAmount();
    }
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
    Object.assign(r, {
      propertyId: propS.value,
      category: catS.value,
      amount: Number(amountI.value),
      currency: currencyS.value,
      date: dateI.value,
      vendorId: vendorS.value || '',
      vendor: selectedVendor?.name || r.vendor || '',
      description: descT.value.trim(),
      stream: streamS.value
    });
    upsert('expenses', r);
    toast(existing ? 'Expense updated' : 'Expense added', 'success');
    closeModal();
    setTimeout(() => navigate('expenses'), 200);
  }});
  const cancel = button('Cancel', { onClick: closeModal });
  openModal({ title: existing ? 'Edit Expense' : 'New Expense', body, footer: [cancel, save] });
}
