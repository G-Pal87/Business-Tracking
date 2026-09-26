// Shared UI helper utilities for analytics modals and drill-downs.
// Import these instead of copy-pasting the equivalent mkExp* functions
// into every analytics module.
import { el, openModal } from '../core/ui.js';
import { state } from '../core/state.js';
import { formatEUR, byId, toEUR } from '../core/data.js';
import { todayYmd, addDaysYmd, diffDaysYmd } from '../core/dates.js';

// ── Section label ─────────────────────────────────────────────────────────────

/**
 * mkSectionLabel(text) — uppercase muted section divider.
 * Renders a small all-caps label used to separate subsections inside modals.
 */
export function mkSectionLabel(text) {
  return el('div', {
    style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin:0 0 8px'
  }, text);
}

// ── Summary box ───────────────────────────────────────────────────────────────

/**
 * mkSummaryBox(label, value, sub, explain) — bordered metric card with optional subtitle.
 * Renders a single KPI-style card suitable for placing in a summary grid.
 *
 * @param {string} label  - Small muted label above the value.
 * @param {string} value  - Primary large value text.
 * @param {string|null} sub - Optional muted subtitle rendered below the value.
 * @param {object|null} [explain] - Optional {@link mkExplainButton} payload; when
 *   present, renders a small "ⓘ" next to the label that opens a compact modal
 *   showing the formula, the core inputs that fed into it, and a source
 *   file:line reference — see mkExplainButton for the exact shape.
 */
export function mkSummaryBox(label, value, sub, explain) {
  const box = el('div', {
    style: 'padding:12px;border-radius:6px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08)'
  });
  const labelRow = el('div', { style: 'font-size:11px;color:var(--text-muted);margin-bottom:4px;display:flex;align-items:center;gap:4px' }, label);
  if (explain) labelRow.appendChild(mkExplainButton(explain));
  box.appendChild(labelRow);
  box.appendChild(el('div', { style: 'font-size:17px;font-weight:700;color:var(--text)' }, value));
  if (sub) box.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:2px' }, sub));
  return box;
}

// ── Summary grid ──────────────────────────────────────────────────────────────

/**
 * mkSummaryGrid(boxes, cols=2) — wraps summary boxes in a responsive grid.
 * Each element of `boxes` is passed to mkSummaryBox as {label, value, sub, explain}.
 *
 * @param {Array<{label:string, value:string, sub?:string, explain?:object}>} boxes
 * @param {number} cols - Number of columns in the CSS grid (default 2).
 * @returns {HTMLElement} div with grid layout containing the rendered boxes.
 */
export function mkSummaryGrid(boxes, cols = 2) {
  const grid = el('div', {
    style: `display:grid;grid-template-columns:repeat(${cols},1fr);gap:12px;margin-bottom:20px`
  });
  for (const { label, value, sub, explain } of boxes) {
    grid.appendChild(mkSummaryBox(label, value, sub ?? null, explain ?? null));
  }
  return grid;
}

// ── Modal table ───────────────────────────────────────────────────────────────

/**
 * mkModalTable(headers, rows, opts={}) — styled table for use inside modals.
 *
 * Headers may be plain strings or descriptor objects:
 *   { label: string, right?: boolean, muted?: boolean, tip?: string }
 * When objects are supplied, `right` controls text alignment and `muted`
 * renders cell text in `var(--text-muted)` instead of `var(--text)`. `tip`,
 * when given, renders as a native hover tooltip on that header explaining
 * what the column represents.
 * Plain-string headers fall back to the legacy behaviour (first col left,
 * all others right-aligned).
 *
 * @param {Array<string|{label:string, right?:boolean, muted?:boolean, tip?:string}>} headers
 * @param {Array<Array<string|HTMLElement>>} rows - 2-D array of cell contents.
 * @param {object} [opts]
 * @param {number} [opts.highlight]      - Column index to render in bold (default: none).
 * @param {boolean} [opts.firstColLeft]  - Keep first column left-aligned when using
 *                                         plain-string headers (default: true).
 */
export function mkModalTable(headers, rows, opts = {}) {
  const { highlight, firstColLeft = true } = opts;

  // Normalise headers — accept plain strings or {label, right, muted, tip} objects.
  const useObjects = headers.length > 0 && typeof headers[0] === 'object' && headers[0] !== null;
  const cols = headers.map((h, hi) => {
    if (useObjects) {
      return { label: h.label ?? '', right: !!h.right, muted: !!h.muted, tip: h.tip || '' };
    }
    // Legacy plain-string mode: first column left, rest right.
    return { label: String(h), right: !(hi === 0 && firstColLeft), muted: false, tip: '' };
  });

  const tbl = el('table', { style: 'width:100%;border-collapse:collapse;font-size:13px' });

  // Header row
  const hrow = el('tr');
  cols.forEach(col => {
    hrow.appendChild(el('th', {
      title: col.tip || '',
      style: `padding:4px 8px;text-align:${col.right ? 'right' : 'left'};color:var(--text-muted);font-size:11px;` +
             `${col.tip ? 'cursor:help;' : ''}` +
             `border-bottom:1px solid rgba(255,255,255,0.08)`
    }, col.label));
  });
  tbl.appendChild(el('thead', {}, hrow));

  // Body rows
  const tbody = el('tbody');
  rows.forEach((cells, ri) => {
    const tr = el('tr', {
      style: ri % 2 === 1 ? 'background:rgba(255,255,255,0.02)' : ''
    });
    cells.forEach((cell, ci) => {
      const col   = cols[ci] || { right: false, muted: false };
      const color = col.muted ? 'var(--text-muted)' : 'var(--text)';
      const bold  = ci === highlight ? 'font-weight:700;' : '';
      const td = el('td', {
        style: `padding:6px 8px;text-align:${col.right ? 'right' : 'left'};${bold}color:${color}`
      });
      if (cell instanceof Node) {
        td.appendChild(cell);
      } else {
        td.appendChild(document.createTextNode(cell ?? '—'));
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);

  // Wrapped in .table-wrap (same convention drillDownModal already uses) so
  // a wide table scrolls horizontally instead of overflowing the modal on a
  // narrow screen — every caller just appends the return value, so this is
  // a transparent change for all of them.
  const tw = el('div', { class: 'table-wrap' });
  tw.appendChild(tbl);
  return tw;
}

// ── Column header with hover tooltip ─────────────────────────────────────────

/**
 * mkTh(col) — <th> cell for hand-rolled tables (i.e. not going through
 * mkModalTable, e.g. a full-page summary table's own header row), with an
 * optional hover tooltip describing what the column represents.
 *
 * @param {{label:string, right?:boolean, tip?:string}} col
 * @returns {HTMLElement}
 */
export function mkTh(col) {
  return el('th', {
    class: col.right ? 'right' : '',
    title: col.tip || '',
    style: col.tip ? 'cursor:help' : ''
  }, col.label);
}

// ── Explain-this-calculation drill-in ────────────────────────────────────────

/**
 * mkExplainButton(explain) — small "ⓘ" affordance that opens a compact modal
 * showing how a figure was calculated: the formula in plain terms, the core
 * input values that fed into it, and (per the app's own convention of citing
 * file:line when explaining a calculation) a source reference pointing at the
 * function that computed it.
 *
 * Meant to sit next to a label wherever mkSummaryBox/mkSummaryGrid render a
 * computed figure a user might reasonably ask "how did you get this number?"
 * about — not every figure needs one; skip it for raw sums pulled straight
 * from a single field (e.g. "Purchase Price").
 *
 * @param {object} explain
 * @param {string} explain.title    - Modal title, e.g. "Simple ROI".
 * @param {string} [explain.formula] - Plain-text formula, e.g. "Net Income ÷ Total Invested × 100".
 * @param {Array<{label:string, value:string}>} [explain.inputs] - Core data
 *   this figure was built from, shown as a compact label/value table.
 * @param {string} [explain.source] - "file.js:123 functionName()" reference.
 * @param {string} [explain.note]   - Optional short freeform caveat/context line.
 * @returns {HTMLElement} span — the clickable "ⓘ" trigger.
 */
export function mkExplainButton(explain) {
  const btn = el('span', {
    title: 'How is this calculated?',
    style: 'cursor:pointer;color:var(--text-muted);font-size:11px;line-height:1;border:1px solid rgba(255,255,255,0.15);' +
           'border-radius:50%;width:13px;height:13px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0'
  }, 'i');
  btn.onclick = e => {
    e.stopPropagation();
    const body = el('div');
    if (explain.formula) {
      body.appendChild(el('div', {
        style: 'font-family:monospace;font-size:13px;background:rgba(255,255,255,0.04);' +
               'border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:8px 10px;margin-bottom:12px'
      }, explain.formula));
    }
    if (explain.inputs?.length) {
      body.appendChild(mkSectionLabel('Core Data'));
      body.appendChild(mkModalTable(
        [{ label: 'Input' }, { label: 'Value', right: true }],
        explain.inputs.map(i => [i.label, i.value])
      ));
    }
    if (explain.note) {
      body.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:10px;line-height:1.4' }, explain.note));
    }
    if (explain.source) {
      body.appendChild(el('div', {
        style: 'margin-top:12px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08);' +
               'font-family:monospace;font-size:11px;color:var(--text-muted)'
      }, `Source: ${explain.source}`));
    }
    openModal({ title: explain.title || 'How this is calculated', body });
  };
  return btn;
}

// ── Variance badge ────────────────────────────────────────────────────────────

/**
 * mkVarianceBadge(value, formatted) — inline colored badge for variance values.
 * Positive → green, negative → red, zero → muted.
 * The sign (+/-) is prepended automatically.
 *
 * @param {number} value     - Raw numeric value to determine color and sign.
 * @param {string} formatted - Pre-formatted string to display (e.g. "€1,234").
 * @returns {HTMLElement} span element.
 */
export function mkVarianceBadge(value, formatted) {
  let color, sign;
  if (value > 0) {
    color = 'var(--green, #22c55e)';
    sign  = '+';
  } else if (value < 0) {
    color = 'var(--red, #ef4444)';
    sign  = '';   // formatted value already carries the minus sign
  } else {
    color = 'var(--text-muted)';
    sign  = '';
  }
  return el('span', {
    style: `display:inline-block;font-size:12px;font-weight:600;color:${color};` +
           `padding:1px 5px;border-radius:3px;background:${value > 0
             ? 'rgba(34,197,94,0.10)'
             : value < 0
               ? 'rgba(239,68,68,0.10)'
               : 'rgba(255,255,255,0.04)'}`
  }, `${sign}${formatted}`);
}

// ── Progress bar ──────────────────────────────────────────────────────────────

/**
 * mkProgressBar(pct, color) — thin progress bar element.
 *
 * @param {number} pct   - Fill percentage, clamped to 0–100.
 * @param {string} color - CSS color string for the filled portion.
 * @returns {HTMLElement} Outer div containing the colored inner bar.
 */
export function mkProgressBar(pct, color) {
  const clamped = Math.min(100, Math.max(0, pct));
  const outer   = el('div', {
    style: 'width:100%;height:6px;border-radius:3px;background:rgba(255,255,255,0.06);overflow:hidden'
  });
  outer.appendChild(el('div', {
    style: `width:${clamped}%;height:100%;border-radius:3px;background:${color};transition:width 300ms ease`
  }));
  return outer;
}

// ── KPI card ──────────────────────────────────────────────────────────────────

/**
 * mkKpiCard(opts) — standard KPI card used across all analytics dashboards.
 *
 * Replaces local kpiCard / compositeKpiCard definitions in every module.
 *
 * @param {object} opts
 * @param {string}   opts.label        - Small muted label above the value.
 * @param {string}   opts.value        - Primary large value text.
 * @param {string}   [opts.subtitle]   - Small muted text below the value / lines.
 * @param {number}   [opts.delta]      - Period-over-period change percentage.
 * @param {boolean}  [opts.deltaIsPp]  - Treat delta as percentage points (pp).
 * @param {string}   [opts.deltaUnit]  - Show delta as an absolute change in this unit
 *   (e.g. 'mo') instead of % / pp. Takes precedence over deltaIsPp.
 * @param {boolean}  [opts.invertDelta]- Flip green/red (e.g. expenses: lower is better).
 * @param {string}   [opts.compLabel]  - Label shown after "vs " in the trend line.
 * @param {string}   [opts.variant]    - CSS class suffix: 'danger' | 'warning' | 'success'.
 * @param {Function} [opts.onClick]    - Click handler; adds hover highlight when provided.
 * @param {Array}    [opts.lines]      - Breakdown lines for composite cards.
 *   Each line: { label, value, pct?, onClick? }
 * @param {object}   [opts.explain]    - Optional mkExplainButton payload — renders a
 *   small "ⓘ" next to the label that opens a compact "how is this calculated" modal.
 *   Independent of onClick (stops propagation so it never also triggers the card's
 *   own drill-down click).
 */
export function mkKpiCard({ label, value, subtitle, delta, deltaIsPp, deltaUnit, invertDelta, compLabel, compValue, variant, onClick, lines, explain } = {}) {
  const card = el('div', {
    class: 'kpi' + (variant ? ' ' + variant : ''),
    style: onClick ? 'cursor:pointer;transition:box-shadow 120ms' : '',
    title: onClick ? 'Click for breakdown' : ''
  });
  if (onClick) {
    card.addEventListener('mouseenter', () => { card.style.boxShadow = '0 0 0 2px var(--accent)'; });
    card.addEventListener('mouseleave', () => { card.style.boxShadow = ''; });
    card.onclick = onClick;
  }

  if (explain) {
    const labelRow = el('div', { class: 'kpi-label', style: 'display:flex;align-items:center;gap:4px' }, label);
    labelRow.appendChild(mkExplainButton(explain));
    card.appendChild(labelRow);
  } else {
    card.appendChild(el('div', { class: 'kpi-label' }, label));
  }
  card.appendChild(el('div', { class: 'kpi-value' }, value));

  if (delta !== null && delta !== undefined && isFinite(delta)) {
    const trend = el('div', { class: 'kpi-trend' });
    const sign  = delta > 0 ? '+' : '';
    const disp  = deltaUnit ? `${sign}${delta.toFixed(1)} ${deltaUnit}`
                : deltaIsPp ? `${sign}${delta.toFixed(1)} pp` : `${sign}${delta.toFixed(1)}%`;
    const cls   = delta === 0 ? '' : delta > 0 ? (invertDelta ? 'down' : 'up') : (invertDelta ? 'up' : 'down');
    trend.appendChild(el('span', { class: cls }, disp));
    if (compLabel && !compValue) trend.appendChild(document.createTextNode(` vs ${compLabel}`));
    card.appendChild(trend);
    if (compValue) card.appendChild(el('div', {
      style: 'font-size:11px;color:var(--text-muted);margin-top:1px'
    }, compLabel ? `${compValue} vs ${compLabel}` : `${compValue} prev`));
  }

  if (lines?.length) {
    card.appendChild(el('div', { style: 'margin:8px 0 6px;border-top:1px solid rgba(255,255,255,0.06)' }));
    for (const ln of lines) {
      const row = el('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;gap:6px;font-size:11px;padding:2px 4px;margin:0 -4px;border-radius:3px' });
      row.appendChild(el('span', { style: 'color:var(--text-muted);flex-shrink:0' }, ln.label));
      row.appendChild(el('span', { style: 'color:var(--text);font-weight:500;min-width:0;word-break:break-word;text-align:right' },
        ln.value + (ln.pct !== undefined ? ` (${ln.pct})` : '')
      ));
      if (ln.onClick) {
        row.style.cursor = 'pointer';
        row.addEventListener('mouseenter', () => { row.style.background = 'rgba(255,255,255,0.05)'; });
        row.addEventListener('mouseleave', () => { row.style.background = ''; });
        row.onclick = e => { e.stopPropagation(); ln.onClick(); };
      }
      card.appendChild(row);
    }
  }

  if (subtitle) card.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:2px' }, subtitle));
  card.appendChild(el('div', { class: 'kpi-accent-bar' }));
  return card;
}

// ── Comparison grid ───────────────────────────────────────────────────────────

/**
 * mkCmpGrid(items, curLabel, cmpLabel) — side-by-side comparison summary.
 * items = [{label, curVal, cmpVal, curSub?, cmpSub?, explain?}]
 * `explain` (an mkExplainButton payload) is the same metric's calculation
 * regardless of period, so it's shown on both the current and comparison box.
 */
export function mkCmpGrid(items, curLabel, cmpLabel) {
  const wrap = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px' });
  const headerStyle = 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-bottom:8px';
  for (const [lbl, vals] of [
    [curLabel,         items.map(i => [i.label, i.curVal, i.curSub ?? null, i.explain ?? null])],
    [`vs ${cmpLabel}`, items.map(i => [i.label, i.cmpVal, i.cmpSub ?? null, i.explain ?? null])]
  ]) {
    const col = el('div');
    col.appendChild(el('div', { style: headerStyle }, lbl));
    vals.forEach(([label, value, sub, explain]) => col.appendChild(mkSummaryBox(label, value, sub, explain)));
    wrap.appendChild(col);
  }
  return wrap;
}

// ── Drillable value ───────────────────────────────────────────────────────────

/**
 * mkDrillValue(text, onClick) — wraps a displayed figure in a subtle clickable
 * affordance (dotted underline) that opens a drill-down of the real records
 * behind it when clicked.
 *
 * This is deliberately distinct from mkExplainButton: that answers "how was
 * this calculated" (the formula, in the abstract); this answers "what's
 * actually in this number" (the real payments/expenses/invoices that summed
 * to it) — typically wired to drillDownModal() with whatever record array
 * already produced the figure, so most call sites need no new computation,
 * just a click handler over data already in scope.
 *
 * Works as a drop-in value anywhere a Node is accepted — mkSummaryBox's
 * `value`, an mkModalTable cell, an mkKpiCard line value, etc.
 *
 * @param {string|HTMLElement} text - Display value.
 * @param {() => void} onClick - Opens the drill-down (typically a drillDownModal call).
 * @returns {HTMLElement}
 */
export function mkDrillValue(text, onClick) {
  const span = el('span', {
    style: 'cursor:pointer;text-decoration:underline;text-decoration-style:dotted;' +
           'text-decoration-color:var(--text-muted);text-underline-offset:3px',
    title: 'Click to see the records behind this figure'
  });
  span.appendChild(typeof text === 'string' ? document.createTextNode(text) : text);
  span.onclick = e => { e.stopPropagation(); onClick(); };
  return span;
}

// ── Empty state ───────────────────────────────────────────────────────────────

/**
 * mkEmptyState(message) — empty state div for modals with no data.
 * Renders centered muted italic text.
 *
 * @param {string} message - Text to display.
 * @returns {HTMLElement}
 */
export function mkEmptyState(message) {
  return el('div', {
    style: 'padding:32px 16px;text-align:center;color:var(--text-muted);font-style:italic;font-size:13px'
  }, message);
}

// ── Shared numeric utilities ──────────────────────────────────────────────────

/**
 * safePct(cur, cmp) — safe period-over-period percentage change.
 * Returns null when cmp is zero, null, or non-finite.
 */
export function safePct(cur, cmp) {
  if (cmp == null || !isFinite(cmp) || cmp === 0) return null;
  const v = (cur - cmp) / Math.abs(cmp) * 100;
  return isFinite(v) ? v : null;
}

/**
 * fmtK(v) — compact EUR formatter for chart axis labels.
 * ≥10 000 → "€12k", ≥1 000 → "€1.2k", otherwise formatEUR.
 */
export const fmtK = v =>
  v >= 10000 ? `€${(v / 1000).toFixed(0)}k`
  : v >= 1000 ? `€${(v / 1000).toFixed(1)}k`
  : formatEUR(v, { maxFrac: 0 });

/**
 * groupByMonthKey(rows, dateOf) — group records into a Map keyed by 'YYYY-MM'.
 *
 * The bucket key is `dateOf(row).slice(0, 7)`; rows with a missing/empty date
 * are skipped. This is built to be an exact, reusable substitute for the
 * `rows.filter(r => dateOf(r)?.slice(0, 7) === key)` pattern repeated across the
 * dashboards: for any month key, `map.get(key) || []` yields the identical
 * subset, so any sum/reduce over it produces the identical number. Building the
 * map once turns O(charts × months × n) re-filtering into a single O(n) pass.
 *
 * @param {Array<object>} rows
 * @param {(row:object)=>(string|undefined|null)} dateOf
 * @returns {Map<string, object[]>}
 */
export function groupByMonthKey(rows, dateOf) {
  const m = new Map();
  for (const r of rows) {
    const d = dateOf(r);
    if (!d) continue;
    const key = d.slice(0, 7);
    let arr = m.get(key);
    if (!arr) { arr = []; m.set(key, arr); }
    arr.push(r);
  }
  return m;
}

/**
 * streamOf(row, fallback=null) — THE single business-stream resolver for any
 * record (payment, invoice, expense): row.stream first, then inferred from the
 * linked property's type, else `fallback`.
 *
 * Use `fallback: null` (the default — what analytics-filters.js resolveStream()
 * returns) for filter matching, where "no stream" must not match a selected
 * stream; use 'other' for breakdowns/charts so every record lands in some
 * bucket and the breakdown sums to the headline total.
 */
export function streamOf(row, fallback = null) {
  if (row.stream) return row.stream;
  if (row.propertyId) {
    const p = byId('properties', row.propertyId);
    if (p?.type === 'short_term') return 'short_term_rental';
    if (p?.type === 'long_term')  return 'long_term_rental';
  }
  return fallback;
}

/**
 * expStream(e) — resolve the business stream for an expense record.
 * Same as streamOf(e, 'other') (kept for existing importers).
 */
export function expStream(e) {
  return streamOf(e, 'other');
}

// ── Invoice semantics (single definitions — reuse, don't re-derive) ───────────

/**
 * invoiceNetEUR(inv) — invoice REVENUE in EUR: VAT-exclusive `subtotal`
 * (falls back to `total` for legacy records without a subtotal), converted at
 * the issue date. Revenue is net of VAT everywhere — same rule as data.js
 * sumInvoicesEUR(). Use this for any figure labelled "revenue".
 */
export function invoiceNetEUR(inv) {
  return toEUR(inv.subtotal ?? inv.total, inv.currency, inv.issueDate);
}

/**
 * invoiceGrossEUR(inv) — VAT-inclusive `total` in EUR at the issue date.
 * Only for cash/receivable figures (outstanding/overdue balances, aging,
 * collection rate) — the client owes the full amount including VAT.
 */
export function invoiceGrossEUR(inv) {
  return toEUR(inv.total, inv.currency, inv.issueDate);
}

/** Payment terms assumed when an invoice has no dueDate. */
export const INVOICE_DEFAULT_TERMS_DAYS = 30;

/**
 * invoiceDueDate(inv) — 'YYYY-MM-DD' due date: inv.dueDate, else
 * issueDate + INVOICE_DEFAULT_TERMS_DAYS (timezone-safe), else ''.
 */
export function invoiceDueDate(inv) {
  if (inv.dueDate) return inv.dueDate;
  return inv.issueDate ? addDaysYmd(inv.issueDate, INVOICE_DEFAULT_TERMS_DAYS) : '';
}

/**
 * classifyInvoice(inv, todayStr=todayYmd()) → one of
 *   'paid'        — status paid
 *   'draft'       — status draft (never outstanding, never in collection rate)
 *   'void'        — status cancelled/void (ignored everywhere)
 *   'overdue'     — outstanding AND (status 'overdue' OR due date < today)
 *   'outstanding' — outstanding (sent / any other unpaid status), not yet overdue
 * "Outstanding" in the broad sense = 'outstanding' + 'overdue'.
 */
export function classifyInvoice(inv, todayStr = todayYmd()) {
  const s = inv.status;
  if (s === 'paid')  return 'paid';
  if (s === 'draft') return 'draft';
  if (s === 'cancelled' || s === 'void') return 'void';
  if (s === 'overdue') return 'overdue';
  const due = invoiceDueDate(inv);
  return due && due < todayStr ? 'overdue' : 'outstanding';
}

/**
 * invoiceBuckets(invs, todayStr=todayYmd()) — classify a list once.
 * Returns {
 *   paid, draft, voided,           // arrays
 *   outstanding,                   // sent+overdue (every unpaid, non-draft, non-void)
 *   overdue,                       // subset of outstanding past due (see classifyInvoice)
 *   notDue,                        // outstanding minus overdue
 *   paidGross, outstandingGross, overdueGross,  // VAT-inclusive EUR (cash view)
 *   paidNet,                       // VAT-exclusive EUR (revenue view)
 *   collectionRate                 // paidGross / (paidGross + outstandingGross) × 100, or null
 * }
 */
export function invoiceBuckets(invs, todayStr = todayYmd()) {
  const r = { paid: [], draft: [], voided: [], outstanding: [], overdue: [], notDue: [],
              paidGross: 0, paidNet: 0, outstandingGross: 0, overdueGross: 0, collectionRate: null };
  for (const i of invs) {
    const c = classifyInvoice(i, todayStr);
    if (c === 'paid') { r.paid.push(i); r.paidGross += invoiceGrossEUR(i); r.paidNet += invoiceNetEUR(i); }
    else if (c === 'draft') r.draft.push(i);
    else if (c === 'void')  r.voided.push(i);
    else {
      const g = invoiceGrossEUR(i);
      r.outstanding.push(i); r.outstandingGross += g;
      if (c === 'overdue') { r.overdue.push(i); r.overdueGross += g; }
      else r.notDue.push(i);
    }
  }
  const den = r.paidGross + r.outstandingGross;
  r.collectionRate = den > 0 ? r.paidGross / den * 100 : null;
  return r;
}

/** Aging bucket labels, index-aligned with invoiceAgingBucket(). */
export const AGING_BUCKETS = ['Not due', '1–30 days', '31–60 days', '61–90 days', '90+ days'];

/**
 * invoiceDaysPastDue(inv, todayStr=todayYmd()) — whole days since
 * invoiceDueDate(inv), floored at 0 (0 = not yet due or no dates at all).
 */
export function invoiceDaysPastDue(inv, todayStr = todayYmd()) {
  const due = invoiceDueDate(inv);
  return due ? Math.max(0, diffDaysYmd(due, todayStr)) : 0;
}

/**
 * invoiceAgingBucket(inv, todayStr=todayYmd()) — index into AGING_BUCKETS for
 * an OUTSTANDING invoice. 0 = 'Not due' exactly when classifyInvoice() isn't
 * 'overdue'; an invoice manually marked overdue before its due date goes in
 * the first overdue bucket so the chart agrees with the overdue KPI.
 */
export function invoiceAgingBucket(inv, todayStr = todayYmd()) {
  if (classifyInvoice(inv, todayStr) !== 'overdue') return 0;
  const days = invoiceDaysPastDue(inv, todayStr);
  return days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4;
}

/**
 * invoiceOwner(inv) — THE owner rule for invoices: inv.owner, else the linked
 * property's owner (when inv.propertyId), else the client's owner, else
 * 'both' (shared). Match with `ow === 'both' || selectedOwners.has(ow)` — see
 * analytics-filters.js makeMatchers().mInvOwner.
 */
export function invoiceOwner(inv) {
  if (inv.owner) return inv.owner;
  if (inv.propertyId) {
    const ow = byId('properties', inv.propertyId)?.owner;
    if (ow) return ow;
  }
  if (inv.clientId) {
    const ow = byId('clients', inv.clientId)?.owner;
    if (ow) return ow;
  }
  return 'both';
}

// ── Insights banner ───────────────────────────────────────────────────────────

/**
 * mkInsightsBanner(signals, title) — severity-coded insight cards.
 * Used by Services and Properties dashboards.
 *
 * @param {Array<{severity:string, title:string, text:string, inspect?:string}>} signals
 * @param {string} title - Card header title.
 * @returns {HTMLElement|null} null when signals is empty.
 */
export function mkInsightsBanner(signals, title) {
  if (!signals.length) return null;
  const SEV_COLOR = { 'At Risk': '#ef4444', 'Watch': '#f59e0b', 'Note': '#6366f1' };
  const SEV_BG    = { 'At Risk': 'rgba(239,68,68,0.06)', 'Watch': 'rgba(245,158,11,0.06)', 'Note': 'rgba(99,102,241,0.06)' };

  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, title)
  ));

  const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;padding:16px' });

  for (const sig of signals) {
    const color = SEV_COLOR[sig.severity] || SEV_COLOR['Note'];
    const bg    = SEV_BG[sig.severity]    || SEV_BG['Note'];
    const block = el('div', {
      style: `background:${bg};border-left:3px solid ${color};border-radius:0 var(--radius-sm) var(--radius-sm) 0;padding:12px 14px`
    });
    const titleRow = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px' });
    titleRow.appendChild(el('span', { style: `font-size:11px;font-weight:700;letter-spacing:0.5px;color:${color}` }, sig.title));
    titleRow.appendChild(el('span', { style: `font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;background:${color};color:#fff` }, sig.severity));
    block.appendChild(titleRow);
    const p = el('p', { style: 'margin:0 0 6px;font-size:12px;color:var(--text);line-height:1.4' }, sig.text);
    if (sig.onClick) { p.style.cursor = 'pointer'; p.title = 'Click for breakdown'; p.onclick = sig.onClick; }
    block.appendChild(p);
    if (sig.inspect) {
      block.appendChild(el('div', { style: `font-size:11px;color:${color};font-weight:600` }, `→ Inspect: ${sig.inspect}`));
    }
    grid.appendChild(block);
  }

  card.appendChild(grid);
  return card;
}

// ── Owner attribution (payments / expenses) & partner keys ───────────────────
// (import placed here so the helpers above stay untouched; ES imports are
// hoisted, so position doesn't matter)
import { listActive as _listActiveForOwners } from '../core/data.js';

/**
 * recordOwner(r) — THE owner rule for PAYMENTS and EXPENSES, identical to
 * analytics-filters.js makeMatchers().mOwner so the owner filter and every
 * owner split agree: a property-linked record takes its property's owner
 * (unset → 'both'); a record with no property uses its own `owner`, else
 * 'both'. (Invoices use invoiceOwner() instead.)
 */
export function recordOwner(r) {
  if (r.propertyId) return byId('properties', r.propertyId)?.owner || 'both';
  return r.owner || 'both';
}

const _warnedOwnerKeys = new Set();
/**
 * partnerKey(key) — normalise any stored owner value to 'you' | 'rita' |
 * 'both'. Owner fields hold getPeopleOwners() values (a people record's
 * legacyKey, or its id when it has none), so a people-id is resolved to that
 * person's legacyKey, else by name ('giorgos' → 'you', 'rita' → 'rita' —
 * the same fallback analytics-personal.js getPersonData() uses). A key that
 * still can't be resolved is counted as 'both' (the two-partner dashboards
 * have no other bucket) but logged once, so it is never silently re-assigned.
 */
export function partnerKey(key) {
  if (!key || key === 'both') return 'both';
  if (key === 'you' || key === 'rita') return key;
  const person = _listActiveForOwners('people').find(p => p.id === key || p.legacyKey === key);
  if (person?.legacyKey === 'you' || person?.legacyKey === 'rita') return person.legacyKey;
  const name = (person?.name || '').toLowerCase();
  if (name.includes('giorgos')) return 'you';
  if (name.includes('rita')) return 'rita';
  if (!_warnedOwnerKeys.has(key)) {
    _warnedOwnerKeys.add(key);
    console.warn(`[analytics] owner "${key}" does not resolve to Giorgos ('you') or Rita ('rita') — counted as shared (50/50). Set a legacyKey on that people record to attribute it correctly.`);
  }
  return 'both';
}

/**
 * ownerShare(owner, person) — the fraction of a record that belongs to
 * `person` ('you' | 'rita') given its (already resolved) owner: 1 for their
 * own records, 0.5 for shared ('both'), 0 for the other partner's.
 */
export function ownerShare(owner, person) {
  const k = partnerKey(owner);
  return k === 'both' ? 0.5 : k === person ? 1 : 0;
}

// ── Period length (day-based annualisation) ──────────────────────────────────
export const DAYS_PER_YEAR  = 365.25;
export const DAYS_PER_MONTH = DAYS_PER_YEAR / 12; // ≈ 30.44

/** periodDays(start, end) — inclusive calendar days in 'YYYY-MM-DD' range (≥ 0). */
export function periodDays(start, end) {
  if (!start || !end || end < start) return 0;
  return diffDaysYmd(start, end) + 1;
}

// ── Dividend GHS/GESY contribution and SDC ───────────────────────────────────
// Single source for dividends.js and analytics-personal.js.
// GHS (General Healthcare System) on dividends, by payment date:
//   1.70% from 1 Mar 2019, 2.65% from 1 Mar 2020 (the temporary Apr–Jun 2020
//   reduction is not modelled). Applies to every Cyprus tax resident.
// The €180,000 cap is on a person's TOTAL GHS-able income for the year, so
// salary and other income use it up first: the dividend capacity is
// 180,000 − other income (settings.dividendTax.otherIncome[year][recipient]).
// SDC (Special Defence Contribution) applies only to Cyprus-DOMICILED
// residents (settings.dividendTax.domiciled[recipient], default not
// domiciled → no SDC): 17% on dividends paid before 2026, 5% from 1 Jan 2026.
// Either SDC rate can be overridden per year in
// settings.dividendTax.sdcRatePct[year] (a percentage) if the rules change.
export const GHS_RATE       = 0.0265; // current rate — see ghsRateForDate()
export const GHS_ANNUAL_CAP = 180000;

export function ghsRateForDate(date) {
  const d = String(date || '').slice(0, 10);
  if (!d || d >= '2020-03-01') return 0.0265;
  if (d >= '2019-03-01') return 0.017;
  return 0;
}

function dividendTaxSettings() {
  return state.db?.settings?.dividendTax || {};
}

/** Other GHS-able income (salary etc.) a recipient has in `year`, in EUR. */
export function ghsOtherIncome(recipient, year) {
  return Math.max(0, Number(dividendTaxSettings().otherIncome?.[String(year)]?.[recipient]) || 0);
}

/** A recipient's GHS-able dividend capacity for `year` (cap − other income). */
export function ghsDividendCap(recipient, year) {
  return Math.max(0, GHS_ANNUAL_CAP - ghsOtherIncome(recipient, year));
}

export function isDividendRecipientDomiciled(recipient) {
  return dividendTaxSettings().domiciled?.[recipient] === true;
}

export function sdcRateForDate(date) {
  const year = String(date || '').slice(0, 4);
  const raw = dividendTaxSettings().sdcRatePct?.[year];
  if (raw != null && raw !== '' && Number.isFinite(Number(raw)) && Number(raw) >= 0) return Number(raw) / 100;
  return year && year < '2026' ? 0.17 : 0.05;
}

/** SDC withheld on one dividend (0 unless the recipient is domiciled). */
export function sdcForDividend(d) {
  if (!d || !isDividendRecipientDomiciled(d.recipient)) return 0;
  return (Number(d.grossAmount) || 0) * sdcRateForDate(d.date);
}

/**
 * ghsForDividendAmount(amount, priorCum, recipient, date) — GHS on a single
 * (e.g. not-yet-saved) dividend, given the recipient's cumulative gross
 * dividends earlier in the same year.
 */
export function ghsForDividendAmount(amount, priorCum, recipient, date) {
  const cap = ghsDividendCap(recipient, String(date || '').slice(0, 4));
  return Math.min(Number(amount) || 0, Math.max(0, cap - (Number(priorCum) || 0))) * ghsRateForDate(date);
}

/**
 * ghsByDividend(divs) — Map dividend.id → GHS withheld, applying the annual
 * cap (less the recipient's other income) per recipient per calendar year in
 * date order. Pass ALL of a recipient's dividends for the years involved (not
 * just the period's) so earlier dividends in the same year consume the cap
 * first.
 */
export function ghsByDividend(divs) {
  const sorted = [...divs].sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.id).localeCompare(String(b.id)));
  const cum = new Map();
  const out = new Map();
  for (const d of sorted) {
    const key = `${d.recipient || ''}|${(d.date || '').slice(0, 4)}`;
    const prior = cum.get(key) || 0;
    const amt = Number(d.grossAmount) || 0;
    out.set(d.id, ghsForDividendAmount(amt, prior, d.recipient || '', d.date));
    cum.set(key, prior + amt);
  }
  return out;
}
