// Shared UI helper utilities for analytics modals and drill-downs.
// Import these instead of copy-pasting the equivalent mkExp* functions
// into every analytics module.
import { el } from '../core/ui.js';
import { formatEUR, byId } from '../core/data.js';

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
 * Headers may be plain strings or descriptor objects:
 *   { label: string, right?: boolean, muted?: boolean }
 * When objects are supplied, `right` controls text alignment and `muted`
 * renders cell text in `var(--text-muted)` instead of `var(--text)`.
 * Plain-string headers fall back to the legacy behaviour (first col left,
 * all others right-aligned).
 *
 * @param {Array<string|{label:string, right?:boolean, muted?:boolean}>} headers
 * @param {Array<Array<string|HTMLElement>>} rows - 2-D array of cell contents.
 * @param {object} [opts]
 * @param {number} [opts.highlight]      - Column index to render in bold (default: none).
 * @param {boolean} [opts.firstColLeft]  - Keep first column left-aligned when using
 *                                         plain-string headers (default: true).
 */
export function mkModalTable(headers, rows, opts = {}) {
  const { highlight, firstColLeft = true } = opts;

  // Normalise headers — accept plain strings or {label, right, muted} objects.
  const useObjects = headers.length > 0 && typeof headers[0] === 'object' && headers[0] !== null;
  const cols = headers.map((h, hi) => {
    if (useObjects) {
      return { label: h.label ?? '', right: !!h.right, muted: !!h.muted };
    }
    // Legacy plain-string mode: first column left, rest right.
    return { label: String(h), right: !(hi === 0 && firstColLeft), muted: false };
  });

  const tbl = el('table', { style: 'width:100%;border-collapse:collapse;font-size:13px' });

  // Header row
  const hrow = el('tr');
  cols.forEach(col => {
    hrow.appendChild(el('th', {
      style: `padding:4px 8px;text-align:${col.right ? 'right' : 'left'};color:var(--text-muted);font-size:11px;` +
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
 * @param {boolean}  [opts.invertDelta]- Flip green/red (e.g. expenses: lower is better).
 * @param {string}   [opts.compLabel]  - Label shown after "vs " in the trend line.
 * @param {string}   [opts.variant]    - CSS class suffix: 'danger' | 'warning' | 'success'.
 * @param {Function} [opts.onClick]    - Click handler; adds hover highlight when provided.
 * @param {Array}    [opts.lines]      - Breakdown lines for composite cards.
 *   Each line: { label, value, pct?, onClick? }
 */
export function mkKpiCard({ label, value, subtitle, delta, deltaIsPp, invertDelta, compLabel, compValue, variant, onClick, lines } = {}) {
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

  card.appendChild(el('div', { class: 'kpi-label' }, label));
  card.appendChild(el('div', { class: 'kpi-value' }, value));

  if (delta !== null && delta !== undefined && isFinite(delta)) {
    const trend = el('div', { class: 'kpi-trend' });
    const sign  = delta > 0 ? '+' : '';
    const disp  = deltaIsPp ? `${sign}${delta.toFixed(1)} pp` : `${sign}${delta.toFixed(1)}%`;
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
 * items = [{label, curVal, cmpVal, curSub?, cmpSub?}]
 */
export function mkCmpGrid(items, curLabel, cmpLabel) {
  const wrap = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px' });
  const headerStyle = 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-bottom:8px';
  for (const [lbl, vals] of [
    [curLabel,         items.map(i => [i.label, i.curVal, i.curSub ?? null])],
    [`vs ${cmpLabel}`, items.map(i => [i.label, i.cmpVal, i.cmpSub ?? null])]
  ]) {
    const col = el('div');
    col.appendChild(el('div', { style: headerStyle }, lbl));
    vals.forEach(([label, value, sub]) => col.appendChild(mkSummaryBox(label, value, sub)));
    wrap.appendChild(col);
  }
  return wrap;
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
 * expStream(e) — resolve the business stream for an expense record.
 * Checks e.stream first, then infers from the linked property type.
 */
export function expStream(e) {
  if (e.stream) return e.stream;
  if (e.propertyId) {
    const p = byId('properties', e.propertyId);
    if (p?.type === 'short_term') return 'short_term_rental';
    if (p?.type === 'long_term')  return 'long_term_rental';
  }
  return 'other';
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
