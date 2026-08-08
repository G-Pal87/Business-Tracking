// Inventory module — batch-based stock with FIFO deduction
import { state } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, select, input, formRow, textarea, button, fmtDate, today, addDays, attachSortFilter } from '../core/ui.js';
import { upsert, softDelete, listActive, byId, newId, formatMoney, totalRemaining } from '../core/data.js';
import { CURRENCIES } from '../core/config.js';
import { mkTh, mkExplainButton } from './analytics-helpers.js';

let _sortCol = -1, _sortDir = 1, _invSearch = '';

export default {
  id: 'inventory',
  label: 'Inventory',
  icon: '📦',
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
    // Route through upsert() instead of a bare markDirty() so this
    // migration gets an updatedAt/updatedBy stamp like every other write —
    // previously there was no record of when/who ran it.
    upsert('inventory', item);
  }
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

// Projects the calendar date current stock runs out at the recent
// consumption rate, assuming no further restocking — returns null when
// there's no recent usage to project from (nothing to warn about).
function projectedStockout(item, now) {
  const rate = consumptionRate(item, now);
  if (!rate || rate.ratePerDay <= 0) return null;
  const stock = totalRemaining(item);
  if (stock <= 0) return { date: now, daysCover: 0, ratePerDay: rate.ratePerDay };
  const daysCover = stock / rate.ratePerDay;
  return { date: addDays(now, Math.floor(daysCover)), daysCover, ratePerDay: rate.ratePerDay };
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

    const stockoutDate = stock <= 0 ? now : addDays(now, Math.floor(daysCover));

    let severity, lead;
    if (stock <= 0) {
      severity = 'At Risk';
      lead = `Out of stock with active demand (~${perWeek.toFixed(1)}/week).`;
    } else if (daysCover < 14) {
      severity = 'At Risk';
      lead = `Only ~${Math.floor(daysCover)} days of cover left (runs out ~${fmtDate(stockoutDate)}) at ~${perWeek.toFixed(1)}/week usage.`;
    } else {
      severity = 'Watch';
      lead = `~${Math.floor(daysCover)} days of cover (runs out ~${fmtDate(stockoutDate)}) at ~${perWeek.toFixed(1)}/week usage.`;
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

const INV_LIST_COLS = [
  { label: 'Name',          tip: 'Inventory item name.' },
  { label: 'Property',      tip: 'Property this stock is assigned to.' },
  { label: 'Stock',         right: true, tip: 'Total remaining quantity across all purchase batches for this item.' },
  { label: 'Value',         right: true, tip: 'Total value of remaining stock: each batch\'s remaining quantity × its unit price, summed.' },
  { label: 'Last Purchase', tip: 'Date of the most recently dated purchase batch for this item.' },
  { label: 'Runs Out',      tip: 'Projected stockout date, based on the recent consumption rate and assuming no further restocking.' },
  { label: '' }
];

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
  attachSortFilter(tableWrap, { initialCol: _sortCol, initialDir: _sortDir, initialSearch: _invSearch, onSortChange: (c, d) => { _sortCol = c; _sortDir = d; }, onSearchChange: v => { _invSearch = v; } });

  const render = () => {
    insightsWrap.innerHTML = '';
    insightsWrap.appendChild(buildInventoryInsights(render));
    tableWrap.innerHTML = '';
    const rows = listActive('inventory');
    if (rows.length === 0) {
      tableWrap.appendChild(el('div', { class: 'empty' }, 'No inventory items'));
      return;
    }
    const now = today();
    const t = el('table', { class: 'table' });
    const theadTr = el('tr');
    INV_LIST_COLS.forEach(c => theadTr.appendChild(mkTh(c)));
    t.appendChild(el('thead', {}, theadTr));
    const tb = el('tbody');
    for (const item of rows) {
      const stock = totalRemaining(item);
      const value = totalValue(item);
      const last  = latestDate(item);
      const ccy   = firstCurrency(item);
      const prop  = byId('properties', item.propertyId);
      const stockout = projectedStockout(item, now);
      const batches = item.batches || [];

      const tr = el('tr', { style: 'cursor:pointer' });
      // mkExplainButton's own onclick stops propagation, so clicking the "ⓘ"
      // never also triggers this row-open handler.
      tr.onclick = e => { if (!e.target.closest('button')) openBatchesModal(item, render); };
      tr.appendChild(el('td', {}, item.name));
      tr.appendChild(el('td', {}, prop?.name || '—'));
      const stockCls = stock <= 0 ? 'right num muted' : stock <= 5 ? 'right num warning' : 'right num';
      const stockTd = el('td', { class: stockCls, style: 'display:flex;align-items:center;justify-content:flex-end;gap:4px' }, String(stock));
      stockTd.appendChild(mkExplainButton({
        title: 'Stock',
        formula: 'Sum of `remaining` across all of this item\'s purchase batches.',
        inputs: [
          { label: 'Batches counted', value: String(batches.length) },
          { label: 'Total Stock', value: String(stock) }
        ],
        source: 'core/data.js totalRemaining()',
        note: 'Each batch\'s remaining quantity is decremented via FIFO (oldest batch first) as generated expenses consume stock — see core/data.js fifoDeduct().'
      }));
      tr.appendChild(stockTd);
      const valueTd = el('td', { class: 'right num', style: 'display:flex;align-items:center;justify-content:flex-end;gap:4px' }, formatMoney(value, ccy));
      valueTd.appendChild(mkExplainButton({
        title: 'Value',
        formula: 'Σ (batch remaining × batch unit price), summed across all batches.',
        inputs: [
          { label: 'Batches counted', value: String(batches.length) },
          { label: 'Total Value', value: formatMoney(value, ccy) }
        ],
        source: 'js/modules/inventory.js totalValue()',
        note: 'Raw sum of remaining×unitPrice per batch, not currency-converted — if batches were bought in different currencies this total mixes them, and the displayed currency is only the first one found (firstCurrency()).'
      }));
      tr.appendChild(valueTd);
      tr.appendChild(el('td', {}, fmtDate(last)));
      if (stockout) {
        const soonCls = stockout.daysCover < 14 ? 'warning' : '';
        const runsOutTd = el('td', { class: soonCls, style: 'display:flex;align-items:center;gap:4px' }, `${fmtDate(stockout.date)} (~${Math.floor(stockout.daysCover)}d)`);
        runsOutTd.appendChild(mkExplainButton({
          title: 'Runs Out',
          formula: 'Projected stockout date = current stock ÷ recent consumption rate (units/day), projected forward from today.',
          inputs: [
            { label: 'Current Stock', value: String(stock) },
            { label: 'Recent Usage Rate', value: `${stockout.ratePerDay.toFixed(2)}/day` },
            { label: 'Days of Cover', value: `${Math.floor(stockout.daysCover)} days` }
          ],
          source: 'js/modules/inventory.js projectedStockout() / consumptionRate()',
          note: `Usage rate is total inventory-linked expense quantity over the last ${LOOKBACK_DAYS} days (minimum 7-day window), assuming no further restocking. Items with no recent usage show "No usage data" instead of a projection.`
        }));
        tr.appendChild(runsOutTd);
      } else {
        tr.appendChild(el('td', { class: 'muted' }, 'No usage data'));
      }

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

const BATCH_LIST_COLS = [
  { label: 'Date',       tip: 'Date this batch was purchased.' },
  { label: 'Purchased',  right: true, tip: 'Quantity originally purchased in this batch.' },
  { label: 'Remaining',  right: true, tip: 'Quantity left in this batch after FIFO consumption by generated expenses (oldest batches are consumed first).' },
  { label: 'Unit Price', right: true, tip: 'Price paid per unit for this batch, in the batch\'s own currency.' },
  { label: 'Comments',   tip: 'Free-text notes entered for this batch.' },
  { label: '' }
];

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
      const theadTr = el('tr');
      BATCH_LIST_COLS.forEach(c => theadTr.appendChild(mkTh(c)));
      t.appendChild(el('thead', {}, theadTr));
      const tb = el('tbody');
      for (const b of batches) {
        const remaining = b.remaining ?? b.qty ?? 0;
        const tr = el('tr');
        tr.appendChild(el('td', {}, fmtDate(b.dateBought)));
        tr.appendChild(el('td', { class: 'right num' }, String(b.qty || 0)));
        const remCls = remaining <= 0 ? 'right num muted' : remaining <= 5 ? 'right num warning' : 'right num';
        const remTd = el('td', { class: remCls, style: 'display:flex;align-items:center;justify-content:flex-end;gap:4px' }, String(remaining));
        remTd.appendChild(mkExplainButton({
          title: 'Remaining',
          formula: 'Batch remaining quantity, decremented via FIFO as generated expenses consume stock from the oldest batch first.',
          inputs: [
            { label: 'Originally Purchased', value: String(b.qty || 0) },
            { label: 'Remaining', value: String(remaining) }
          ],
          source: 'core/data.js fifoDeduct() / restoreInventoryStock()',
          note: 'Consumption always draws down the oldest batch (by dateBought) first. If a linked expense that consumed from this batch is later deleted, its quantity is credited back here via restoreInventoryStock().'
        }));
        tr.appendChild(remTd);
        tr.appendChild(el('td', { class: 'right num' }, formatMoney(b.unitPrice, b.currency)));
        tr.appendChild(el('td', { class: 'muted', style: 'font-size:12px' }, b.comments || ''));
        const bActs = el('td', { class: 'right' });
        bActs.appendChild(button('Edit', { variant: 'sm ghost', onClick: () => {
          openBatchEditForm(it, b, () => { onUpdate?.(); });
        }}));
        bActs.appendChild(button('Del', { variant: 'sm ghost', onClick: async () => {
          // Block outright rather than warn-and-proceed, matching the house
          // style for "still referenced" deletes elsewhere (see vendors.js's/
          // tenants.js's/clients.js's "Cannot delete — N linked" toasts). A
          // batch consumed by fifoDeduct is named in an active expense's
          // inventoryBatches; if it's deleted here, restoreInventoryStock
          // (core/data.js) can no longer find it by id to credit back the
          // consumed qty if that expense is later deleted, silently losing stock.
          const linkedCount = listActive('expenses')
            .filter(e => (e.inventoryBatches || []).some(ib => ib.batchId === b.id))
            .length;
          if (linkedCount) {
            toast(`Cannot delete — ${linkedCount} expense(s) consumed stock from this batch.`, 'danger', 5000);
            return;
          }
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
    const qty = Number(qtyI.value) || 0;
    const remaining = Number(remI.value);
    const unitPrice = Number(priceI.value) || 0;
    // Matches the validation openAddForm already applies — this form let all
    // of these through unchecked, corrupting stock totals and demand/coverage
    // insights that assume non-negative, qty-bounded values.
    if (qty <= 0)          { toast('Quantity must be > 0', 'danger'); return; }
    if (unitPrice <= 0)    { toast('Unit price must be > 0', 'danger'); return; }
    if (remaining < 0)     { toast('Remaining cannot be negative', 'danger'); return; }
    if (remaining > qty)   { toast('Remaining cannot exceed quantity purchased', 'danger'); return; }
    const fresh = byId('inventory', item.id);
    if (!fresh) { toast('Item not found', 'danger'); return; }
    const updated = {
      ...batch,
      qty, remaining, unitPrice,
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
