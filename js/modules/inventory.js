// Inventory module — batch-based stock with FIFO deduction
import { state, markDirty } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, select, input, formRow, textarea, button, fmtDate, today, attachSortFilter } from '../core/ui.js';
import { upsert, softDelete, listActive, byId, newId, formatMoney, totalRemaining } from '../core/data.js';
import { CURRENCIES } from '../core/config.js';

let _sortCol = -1, _sortDir = 1;

export default {
  id: 'inventory',
  label: 'Inventory',
  icon: 'Inv',
  render(container) { migrateInventoryData(); container.appendChild(build()); },
  refresh() { migrateInventoryData(); const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); },
  destroy() {}
};

export const INVENTORY_ITEMS = [
  'Welcome Drinks', 'Welcome Sweets', 'Hand soap cream', 'Shampoo', 'Chlorine',
  'Toilet Paper', 'Detergent', 'Dish washer tablets', 'Coffee', 'Tea', 'Perfume', 'Olive Oil',
];

// ── Migrate flat items → batched format (idempotent) ──────────────────────────

function migrateInventoryData() {
  const items = state.db.inventory || [];
  let changed = false;
  for (const item of items) {
    if (item.deletedAt || item.batches) continue;
    item.batches = [{
      id:         newId('btc'),
      qty:        item.stock      ?? 0,
      remaining:  item.stock      ?? 0,
      unitPrice:  item.unitPrice  ?? 0,
      currency:   item.currency   || 'EUR',
      dateBought: item.dateBought || today(),
      comments:   item.comments   || ''
    }];
    item.propertyId = item.propertyId || '';
    delete item.stock;
    delete item.unitPrice;
    delete item.currency;
    delete item.dateBought;
    delete item.comments;
    changed = true;
  }
  if (changed) markDirty();
}

// ── Computed helpers ──────────────────────────────────────────────────────────

function totalValue(item) {
  return (item.batches || []).reduce((s, b) => s + (b.remaining ?? b.qty ?? 0) * (b.unitPrice || 0), 0);
}

function latestDate(item) {
  return (item.batches || []).map(b => b.dateBought).filter(Boolean).reduce((a, d) => d > a ? d : a, '');
}

function firstCurrency(item) {
  return (item.batches || []).find(b => b.currency)?.currency || 'EUR';
}

// ── Demand / coverage insights ────────────────────────────────────────────────
// Demand is derived from how fast each item is actually consumed: inventory
// expenses record an `inventoryQty` deducted on a given `date`. We measure the
// recent usage rate (units/day) and project it over a coverage horizon to flag
// items whose remaining stock won't last.

const LOOKBACK_DAYS = 90; // window of past consumption used to estimate the rate
const COVERAGE_DAYS = 30; // demand horizon we want stock to cover

function daysBetween(fromISO, toISO) {
  const a = new Date(fromISO), b = new Date(toISO);
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

// Returns { ratePerDay, recentUsed, spanDays } for an item, or null if no recent usage.
function consumptionRate(item, now) {
  const cons = listActive('expenses')
    .filter(e => e.inventoryItemId === item.id && (e.inventoryQty || 0) > 0 && e.date)
    .filter(e => daysBetween(e.date, now) >= 0 && daysBetween(e.date, now) <= LOOKBACK_DAYS);
  if (!cons.length) return null;

  const recentUsed = cons.reduce((s, e) => s + (e.inventoryQty || 0), 0);
  const firstDate  = cons.reduce((a, e) => (e.date < a ? e.date : a), cons[0].date);
  // Observe the rate over the elapsed period since first recent usage, with a
  // floor (avoid wild projections from a single recent purchase) and a cap.
  const spanDays   = Math.min(LOOKBACK_DAYS, Math.max(7, daysBetween(firstDate, now)));
  return { ratePerDay: recentUsed / spanDays, recentUsed, spanDays };
}

function buildInventoryInsights(onInspect) {
  const now = today();
  const items = listActive('inventory');

  const section = el('div', { class: 'card mb-16' });
  section.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Inventory Performance Insights')
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });

  const signals = []; // { item, title, text, severity, inspect }

  for (const item of items) {
    const rate = consumptionRate(item, now);
    if (!rate || rate.ratePerDay <= 0) continue; // no demand → nothing to warn about

    const stock        = totalRemaining(item);
    const daysCover    = stock <= 0 ? 0 : stock / rate.ratePerDay;
    const projected    = rate.ratePerDay * COVERAGE_DAYS; // demand over the horizon
    const shortfall    = Math.max(0, Math.ceil(projected - stock));
    const propName     = byId('properties', item.propertyId)?.name || '—';
    const perWeek      = rate.ratePerDay * 7;

    // Only surface items that won't cover the demand horizon.
    if (stock > 0 && daysCover >= COVERAGE_DAYS) continue;

    let severity, lead;
    if (stock <= 0) {
      severity = 'At Risk';
      lead = `Out of stock with active demand (~${perWeek.toFixed(1)}/week).`;
    } else if (daysCover < 14) {
      severity = 'At Risk';
      lead = `Only ~${Math.floor(daysCover)} days of cover left at ~${perWeek.toFixed(1)}/week usage.`;
    } else {
      severity = 'Watch';
      lead = `~${Math.floor(daysCover)} days of cover at ~${perWeek.toFixed(1)}/week usage.`;
    }

    const reorder = shortfall > 0
      ? ` Reorder ~${shortfall} unit(s) to cover the next ${COVERAGE_DAYS} days.`
      : '';

    signals.push({
      item,
      title:   `${item.name} — ${propName}`,
      text:    `${lead} Stock ${stock}, projected ${COVERAGE_DAYS}-day demand ~${Math.ceil(projected)}.${reorder}`,
      severity,
      inspect: 'Purchase Batches'
    });
  }

  // Most urgent first: At Risk before Watch, then lowest cover.
  const order = { 'At Risk': 0, 'Watch': 1, 'Note': 2 };
  signals.sort((a, b) => order[a.severity] - order[b.severity]);

  if (!signals.length) {
    body.appendChild(el('div', { style: 'font-size:13px;color:var(--text-muted)' },
      `No inventory coverage risks detected — all items with recent usage have at least ${COVERAGE_DAYS} days of stock.`));
    section.appendChild(body);
    return section;
  }

  const SEV_COLOR = { 'At Risk': '#ef4444', 'Watch': '#f59e0b', 'Note': '#6366f1' };
  const SEV_BG    = { 'At Risk': 'rgba(239,68,68,0.06)', 'Watch': 'rgba(245,158,11,0.06)', 'Note': 'rgba(99,102,241,0.06)' };
  const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px' });

  for (const sig of signals) {
    const color = SEV_COLOR[sig.severity] || '#6b7280';
    const bg    = SEV_BG[sig.severity]    || 'transparent';
    const block = el('div', { style: `padding:10px 12px;border-radius:4px;border-left:3px solid ${color};background:${bg}` });

    const titleRow = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:4px' });
    titleRow.appendChild(el('span', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted)' }, sig.title));
    titleRow.appendChild(el('span', { style: `font-size:10px;font-weight:700;padding:1px 6px;border-radius:10px;color:${color};border:1px solid ${color}` }, sig.severity));
    block.appendChild(titleRow);

    const p = el('p', { style: 'margin:0 0 5px;font-size:12px;line-height:1.5;color:var(--text);cursor:pointer' }, sig.text);
    p.title = 'Click to view batches';
    p.onclick = () => openBatchesModal(sig.item, onInspect);
    block.appendChild(p);
    block.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted)' }, `→ Inspect: ${sig.inspect}`));

    grid.appendChild(block);
  }

  body.appendChild(grid);
  section.appendChild(body);
  return section;
}

// ── Main view ─────────────────────────────────────────────────────────────────

function build() {
  const wrap = el('div', { class: 'view active' });

  const bar = el('div', { class: 'flex gap-8 mb-16' });
  bar.appendChild(el('div', { class: 'flex-1' }));
  bar.appendChild(button('+ Add / Restock', { variant: 'primary', onClick: () => openAddForm(null, render) }));
  wrap.appendChild(bar);

  const insightsWrap = el('div', {});
  wrap.appendChild(insightsWrap);

  const tableWrap = el('div', { class: 'table-wrap' });
  wrap.appendChild(tableWrap);
  attachSortFilter(tableWrap, { initialCol: _sortCol, initialDir: _sortDir, onSortChange: (c, d) => { _sortCol = c; _sortDir = d; } });

  const render = () => {
    insightsWrap.innerHTML = '';
    insightsWrap.appendChild(buildInventoryInsights(render));
    tableWrap.innerHTML = '';
    const rows = listActive('inventory');
    if (rows.length === 0) {
      tableWrap.appendChild(el('div', { class: 'empty' }, 'No inventory items'));
      return;
    }
    const t = el('table', { class: 'table' });
    t.innerHTML = '<thead><tr><th>Name</th><th>Property</th><th class="right">Stock</th><th class="right">Value</th><th>Last Purchase</th><th></th></tr></thead>';
    const tb = el('tbody');
    for (const item of rows) {
      const stock = totalRemaining(item);
      const value = totalValue(item);
      const last  = latestDate(item);
      const ccy   = firstCurrency(item);
      const prop  = byId('properties', item.propertyId);

      const tr = el('tr', { style: 'cursor:pointer' });
      tr.onclick = e => { if (!e.target.closest('button')) openBatchesModal(item, render); };
      tr.appendChild(el('td', {}, item.name));
      tr.appendChild(el('td', {}, prop?.name || '—'));
      const stockCls = stock <= 0 ? 'right num muted' : stock <= 5 ? 'right num warning' : 'right num';
      tr.appendChild(el('td', { class: stockCls }, String(stock)));
      tr.appendChild(el('td', { class: 'right num' }, formatMoney(value, ccy)));
      tr.appendChild(el('td', {}, fmtDate(last)));

      const acts = el('td', { class: 'right' });
      acts.appendChild(button('Restock', { variant: 'sm ghost', onClick: () => openAddForm(item, render) }));
      acts.appendChild(button('Del', { variant: 'sm ghost', onClick: async () => {
        const expCount = listActive('expenses').filter(e => e.inventoryItemId === item.id).length;
        const refNote = expCount ? ` ${expCount} expense(s) reference this item and will remain.` : '';
        const ok = await confirmDialog(`Delete "${item.name}" and all its batches?${refNote}`, { danger: true, okLabel: 'Delete' });
        if (ok) { softDelete('inventory', item.id); toast('Deleted', 'success'); render(); }
      }}));
      tr.appendChild(acts);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    tableWrap.appendChild(t);
  };

  render();
  return wrap;
}

// ── Batch drill-down modal ────────────────────────────────────────────────────

function openBatchesModal(item, onUpdate) {
  const bodyEl = el('div', {});

  const refresh = () => {
    const fresh = byId('inventory', item.id);
    if (fresh) renderBatchList(fresh); else closeModal();
  };

  const renderBatchList = (it) => {
    bodyEl.innerHTML = '';
    const batches = [...(it.batches || [])].sort((a, b) => (a.dateBought || '').localeCompare(b.dateBought || ''));
    if (batches.length === 0) {
      bodyEl.appendChild(el('div', { class: 'empty' }, 'No batches'));
    } else {
      const t = el('table', { class: 'table' });
      t.innerHTML = '<thead><tr><th>Date</th><th class="right">Purchased</th><th class="right">Remaining</th><th class="right">Unit Price</th><th>Comments</th><th></th></tr></thead>';
      const tb = el('tbody');
      for (const b of batches) {
        const remaining = b.remaining ?? b.qty ?? 0;
        const tr = el('tr');
        tr.appendChild(el('td', {}, fmtDate(b.dateBought)));
        tr.appendChild(el('td', { class: 'right num' }, String(b.qty || 0)));
        const remCls = remaining <= 0 ? 'right num muted' : remaining <= 5 ? 'right num warning' : 'right num';
        tr.appendChild(el('td', { class: remCls }, String(remaining)));
        tr.appendChild(el('td', { class: 'right num' }, formatMoney(b.unitPrice, b.currency)));
        tr.appendChild(el('td', { class: 'muted', style: 'font-size:12px' }, b.comments || ''));
        const bActs = el('td', { class: 'right' });
        bActs.appendChild(button('Edit', { variant: 'sm ghost', onClick: () => {
          openBatchEditForm(it, b, () => { onUpdate?.(); });
        }}));
        bActs.appendChild(button('Del', { variant: 'sm ghost', onClick: async () => {
          const ok = await confirmDialog('Delete this batch?', { danger: true, okLabel: 'Delete' });
          if (!ok) return;
          const fresh = byId('inventory', it.id);
          upsert('inventory', { ...fresh, batches: (fresh.batches || []).filter(x => x.id !== b.id) });
          toast('Batch deleted', 'success');
          onUpdate?.();
          refresh();
        }}));
        tr.appendChild(bActs);
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      bodyEl.appendChild(t);
    }
  };

  renderBatchList(item);
  openModal({
    title: `${item.name} — Purchase Batches`,
    body: bodyEl,
    footer: [
      button('Add Batch', { variant: 'primary', onClick: () => {
        openAddForm(item, () => { onUpdate?.(); });
      }}),
      button('Close', { onClick: closeModal })
    ],
    large: true
  });
}

// ── Edit individual batch ─────────────────────────────────────────────────────

function openBatchEditForm(item, batch, onSave) {
  const body = el('div', {});
  const qtyI      = input({ type: 'number', value: batch.qty || 0, min: 0 });
  const remI      = input({ type: 'number', value: batch.remaining ?? batch.qty ?? 0, min: 0 });
  const priceI    = input({ type: 'number', value: batch.unitPrice || 0, min: 0, step: 0.01 });
  const currencyS = select(CURRENCIES, batch.currency || 'EUR');
  const dateI     = input({ type: 'date', value: batch.dateBought || today() });
  const commentsT = textarea({});
  commentsT.value = batch.comments || '';

  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Qty Purchased', qtyI), formRow('Remaining', remI)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Unit Price', priceI), formRow('Currency', currencyS)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Date Bought', dateI)));
  body.appendChild(formRow('Comments', commentsT));

  const saveBtn = button('Save', { variant: 'primary', onClick: () => {
    const fresh = byId('inventory', item.id);
    if (!fresh) { toast('Item not found', 'danger'); return; }
    const updated = {
      ...batch,
      qty:        Number(qtyI.value)   || 0,
      remaining:  Number(remI.value),
      unitPrice:  Number(priceI.value) || 0,
      currency:   currencyS.value,
      dateBought: dateI.value,
      comments:   commentsT.value.trim()
    };
    upsert('inventory', { ...fresh, batches: (fresh.batches || []).map(b => b.id === batch.id ? updated : b) });
    toast('Batch updated', 'success');
    closeModal();
    onSave?.();
  }});

  openModal({ title: 'Edit Batch', body, footer: [button('Cancel', { onClick: closeModal }), saveBtn] });
}

// ── Add item / add batch form ─────────────────────────────────────────────────

function openAddForm(existingItem, onSave) {
  const properties = listActive('properties');
  const body = el('div', {});

  const nameS = select(INVENTORY_ITEMS, existingItem?.name || INVENTORY_ITEMS[0]);
  const propS = select(
    [{ value: '', label: '— Select property —' }, ...properties.map(p => ({ value: p.id, label: p.name }))],
    existingItem?.propertyId || ''
  );
  const qtyI      = input({ type: 'number', value: 0, min: 0 });
  const priceI    = input({ type: 'number', value: 0, min: 0, step: 0.01 });
  const currencyS = select(CURRENCIES, firstCurrency(existingItem || {}) || 'EUR');
  const dateI     = input({ type: 'date', value: today() });
  const commentsT = textarea({ placeholder: 'Notes or comments' });

  if (existingItem) {
    const propName = byId('properties', existingItem.propertyId)?.name || '—';
    body.appendChild(el('div', { style: 'padding:4px 0 12px;color:var(--text-muted);font-size:13px' },
      `Adding batch to: ${existingItem.name} — ${propName}`));
  } else {
    body.appendChild(formRow('Item', nameS));
    body.appendChild(formRow('Property', propS));
  }
  body.appendChild(el('div', { class: 'form-row horizontal' },
    formRow('Qty Purchased', qtyI), formRow('Unit Price', priceI), formRow('Currency', currencyS)
  ));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Date Bought', dateI)));
  body.appendChild(formRow('Comments', commentsT));

  const saveBtn = button('Save', { variant: 'primary', onClick: () => {
    const name       = existingItem ? existingItem.name : nameS.value;
    const propertyId = existingItem ? existingItem.propertyId : propS.value;
    const qty        = Number(qtyI.value) || 0;
    const unitPrice  = Number(priceI.value) || 0;

    if (!existingItem && !propertyId) { toast('Select a property', 'danger'); return; }
    if (qty <= 0)       { toast('Quantity must be > 0', 'danger'); return; }
    if (unitPrice <= 0) { toast('Unit price must be > 0', 'danger'); return; }

    const newBatch = {
      id: newId('btc'), qty, remaining: qty, unitPrice,
      currency: currencyS.value, dateBought: dateI.value, comments: commentsT.value.trim()
    };

    // Find or create the inventory item for this name + property
    const match = existingItem || listActive('inventory').find(i => i.name === name && i.propertyId === propertyId);
    if (match) {
      upsert('inventory', { ...match, batches: [...(match.batches || []), newBatch] });
      toast('Batch added', 'success');
    } else {
      upsert('inventory', { id: newId('ivt'), name, propertyId, batches: [newBatch] });
      toast('Item added', 'success');
    }
    closeModal();
    onSave?.();
  }});

  const title = existingItem ? `Restock — ${existingItem.name}` : 'Add Inventory Item';
  openModal({ title, body, footer: [button('Cancel', { onClick: closeModal }), saveBtn] });
}
