// Inventory module
import { state } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, select, input, formRow, textarea, button, fmtDate, today } from '../core/ui.js';
import { upsert, remove, newId, formatMoney } from '../core/data.js';
import { CURRENCIES } from '../core/config.js';

export default {
  id: 'inventory',
  label: 'Inventory',
  icon: 'Inv',
  render(container) { container.appendChild(build()); },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); },
  destroy() {}
};

function build() {
  const wrap = el('div', { class: 'view active' });

  const bar = el('div', { class: 'flex gap-8 mb-16' });
  bar.appendChild(el('div', { class: 'flex-1' }));
  bar.appendChild(button('+ Add Item', { variant: 'primary', onClick: () => openForm() }));
  wrap.appendChild(bar);

  const tableWrap = el('div', { class: 'table-wrap' });
  wrap.appendChild(tableWrap);

  const render = () => {
    tableWrap.innerHTML = '';
    const rows = [...(state.db.inventory || [])];
    if (rows.length === 0) {
      tableWrap.appendChild(el('div', { class: 'empty' }, 'No inventory items'));
      return;
    }
    const t = el('table', { class: 'table' });
    t.innerHTML = '<thead><tr><th>Name</th><th class="right">Stock</th><th class="right">Unit Price</th><th>Date Bought</th><th>Comments</th><th></th></tr></thead>';
    const tb = el('tbody');
    for (const item of rows) {
      const tr = el('tr');
      tr.appendChild(el('td', {}, item.name));
      const stockCls = item.stock <= 0 ? 'right num muted' : item.stock <= 5 ? 'right num warning' : 'right num';
      tr.appendChild(el('td', { class: stockCls }, String(item.stock)));
      tr.appendChild(el('td', { class: 'right num' }, formatMoney(item.unitPrice, item.currency)));
      tr.appendChild(el('td', {}, fmtDate(item.dateBought)));
      tr.appendChild(el('td', { class: 'muted', style: 'font-size:12px;max-width:200px' }, item.comments || ''));
      const actions = el('td', { class: 'right' });
      actions.appendChild(button('Edit', { variant: 'sm ghost', onClick: () => openForm(item) }));
      actions.appendChild(button('Del', { variant: 'sm ghost', onClick: async () => {
        const ok = await confirmDialog(`Delete "${item.name}"?`, { danger: true, okLabel: 'Delete' });
        if (ok) { remove('inventory', item.id); toast('Deleted', 'success'); render(); }
      }}));
      tr.appendChild(actions);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    tableWrap.appendChild(t);
  };

  render();
  return wrap;
}

function openForm(existing) {
  const r = existing ? { ...existing } : {
    id: newId('ivt'),
    name: '', stock: 0, unitPrice: 0,
    currency: 'EUR', dateBought: today(), comments: ''
  };

  const body = el('div', {});
  const nameI    = input({ value: r.name, placeholder: 'Item name' });
  const stockI   = input({ type: 'number', value: r.stock, min: 0 });
  const priceI   = input({ type: 'number', value: r.unitPrice, min: 0, step: 0.01 });
  const currencyS = select(CURRENCIES, r.currency);
  const dateI    = input({ type: 'date', value: r.dateBought });
  const commentsT = textarea({ placeholder: 'Notes or comments' });
  commentsT.value = r.comments || '';

  body.appendChild(formRow('Name', nameI));
  body.appendChild(el('div', { class: 'form-row horizontal' },
    formRow('Stock Qty', stockI), formRow('Unit Price', priceI), formRow('Currency', currencyS)
  ));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Date Bought', dateI)));
  body.appendChild(formRow('Comments', commentsT));

  const saveBtn = button('Save', { variant: 'primary', onClick: () => {
    if (!nameI.value.trim()) { toast('Name is required', 'danger'); return; }
    Object.assign(r, {
      name: nameI.value.trim(),
      stock: Number(stockI.value) || 0,
      unitPrice: Number(priceI.value) || 0,
      currency: currencyS.value,
      dateBought: dateI.value,
      comments: commentsT.value.trim()
    });
    upsert('inventory', r);
    toast(existing ? 'Item updated' : 'Item added', 'success');
    closeModal();
    setTimeout(() => location.hash = 'inventory', 200);
  }});
  const cancelBtn = button('Cancel', { onClick: closeModal });
  openModal({ title: existing ? 'Edit Item' : 'New Inventory Item', body, footer: [cancelBtn, saveBtn] });
}
