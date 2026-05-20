// Shared UI helper utilities for analytics modals and drill-downs.
// Import these instead of copy-pasting the equivalent mkExp* functions
// into every analytics module.
import { el } from '../core/ui.js';

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
 * mkSummaryBox(label, value, sub) — bordered metric card with optional subtitle.
 * Renders a single KPI-style card suitable for placing in a summary grid.
 *
 * @param {string} label  - Small muted label above the value.
 * @param {string} value  - Primary large value text.
 * @param {string|null} sub - Optional muted subtitle rendered below the value.
 */
export function mkSummaryBox(label, value, sub) {
  const box = el('div', {
    style: 'padding:12px;border-radius:6px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08)'
  });
  box.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-bottom:4px' }, label));
  box.appendChild(el('div', { style: 'font-size:17px;font-weight:700;color:var(--text)' }, value));
  if (sub) box.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:2px' }, sub));
  return box;
}

// ── Summary grid ──────────────────────────────────────────────────────────────

/**
 * mkSummaryGrid(boxes, cols=2) — wraps summary boxes in a responsive grid.
 * Each element of `boxes` is passed to mkSummaryBox as {label, value, sub}.
 *
 * @param {Array<{label:string, value:string, sub?:string}>} boxes
 * @param {number} cols - Number of columns in the CSS grid (default 2).
 * @returns {HTMLElement} div with grid layout containing the rendered boxes.
 */
export function mkSummaryGrid(boxes, cols = 2) {
  const grid = el('div', {
    style: `display:grid;grid-template-columns:repeat(${cols},1fr);gap:12px;margin-bottom:20px`
  });
  for (const { label, value, sub } of boxes) {
    grid.appendChild(mkSummaryBox(label, value, sub ?? null));
  }
  return grid;
}

// ── Modal table ───────────────────────────────────────────────────────────────

/**
 * mkModalTable(headers, rows, opts={}) — styled table for use inside modals.
 *
 * @param {string[]} headers - Column header strings.
 * @param {Array<Array<string|HTMLElement>>} rows - 2-D array of cell contents.
 * @param {object} [opts]
 * @param {number} [opts.highlight]      - Column index to render in bold (default: none).
 * @param {boolean} [opts.firstColLeft]  - Keep first column left-aligned (default: true).
 */
export function mkModalTable(headers, rows, opts = {}) {
  const { highlight, firstColLeft = true } = opts;

  const tbl = el('table', { style: 'width:100%;border-collapse:collapse;font-size:13px' });

  // Header row
  const hrow = el('tr');
  headers.forEach((h, hi) => {
    const isFirst = hi === 0;
    const align   = (isFirst && firstColLeft) ? 'left' : 'right';
    hrow.appendChild(el('th', {
      style: `padding:4px 8px;text-align:${align};color:var(--text-muted);font-size:11px;` +
             `text-transform:uppercase;letter-spacing:0.04em;` +
             `border-bottom:1px solid rgba(255,255,255,0.08)`
    }, h));
  });
  tbl.appendChild(el('thead', {}, hrow));

  // Body rows
  const tbody = el('tbody');
  rows.forEach((cells, ri) => {
    const tr = el('tr', {
      style: ri % 2 === 1 ? 'background:rgba(255,255,255,0.02)' : ''
    });
    cells.forEach((cell, ci) => {
      const isFirst    = ci === 0;
      const align      = (isFirst && firstColLeft) ? 'left' : 'right';
      const bold       = ci === highlight ? 'font-weight:700;' : '';
      const td = el('td', {
        style: `padding:6px 8px;text-align:${align};${bold}color:var(--text)`
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

  return tbl;
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
