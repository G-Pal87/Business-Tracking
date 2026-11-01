// Electricity module — meter readings & invoices for the Hungarian flats
// (logic in core/electricity.js). One row per property per reading cycle,
// with the two steps to tick off: ① reading submitted in the provider's
// system, ② invoice checked & paid (books an Electricity expense).
import { state, markDirty } from '../core/state.js';
import { el, openModal, closeModal, toast, select, input, formRow, textarea, button, fmtDate } from '../core/ui.js';
import { listActive, byId, formatMoney, newId, upsert, normalizeWebsite } from '../core/data.js';
import { CURRENCIES } from '../core/config.js';
import { todayYmd, addDaysYmd } from '../core/dates.js';
import {
  electricityProperties, elecConfig, cyclesFor, electricityRows, electricityActions, DEFAULT_ELEC_CONFIG,
  markReading, undoReading, markInvoicePaid, undoInvoice, markMessaged, messagingSettings, fillTemplate, messageLink, MESSAGE_LEAD_DAYS,
  buildCalendar, applySentMarks, messageFor, MESSAGE_LANGUAGES, langOf
} from '../core/electricity.js';

export default {
  id: 'electricity',
  label: 'Electricity',
  icon: '⚡',
  render(container) { container.appendChild(build()); },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); },
  destroy() {}
};

// Sidebar badge: readings whose window is open/past + invoices due.
// Also picks up "sent" notes left by calendar links tapped in this browser.
export function countElectricityActions() { applySentMarks(); return electricityActions().count; }

// The app's own address: calendar links come back to it (#go=, js/go.js).
const appBaseUrl = () => `${window.location.origin}${window.location.pathname}`;

// Open the tenant's chat / email with the reading request and record it.
async function sendTo(c) {
  const text = messageFor(c);
  const ml = messageLink(c.tenant, text);
  if (!ml) return false;
  if (ml.copyText) {
    try { await navigator.clipboard.writeText(ml.copyText); toast('Message copied — paste it in the Viber chat', 'info', 6000); }
    catch { toast('Could not copy the message — type it in the chat', 'warning'); }
  }
  if (ml.via !== 'call') window.open(ml.href, '_blank', 'noopener');
  else window.location.href = ml.href;
  markMessaged(c, { via: ml.via, accountId: _accountId });
  return true;
}

// Tenants whose window has opened (or is about to) and who haven't been asked yet.
const dueMessages = today => electricityRows(today).filter(c => c.messageable && !c.record?.messagedAt &&
  messageLink(c.tenant, 'x'));

// Step through every due message: each click opens one chat (a click per
// chat keeps the browser from blocking the pop-ups).
function openSendAll(list, rerender) {
  let i = 0;
  const body = el('div', {});
  const draw = () => {
    body.innerHTML = '';
    if (i >= list.length) {
      body.appendChild(el('div', { style: 'font-size:14px;color:var(--success)' }, `✓ Done — ${list.length} tenant(s) messaged.`));
      return;
    }
    const c = list[i];
    const ml = messageLink(c.tenant, messageFor(c));
    body.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:6px' }, `${i + 1} of ${list.length}`));
    body.appendChild(el('div', { style: 'font-size:15px;font-weight:600' }, `${c.tenant.name} — ${c.property.name}`));
    body.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin:2px 0 10px' }, `via ${VIA_LABEL[ml.via]} · ${MESSAGE_LANGUAGES[langOf(c.tenant)]} · window ${fmtDate(c.windowFrom)} – ${fmtDate(c.windowTo)}`));
    body.appendChild(el('div', { style: 'display:flex;gap:8px' },
      button(`Open ${VIA_LABEL[ml.via]} & mark sent`, { variant: 'primary', onClick: async () => { await sendTo(c); i++; draw(); } }),
      button('Skip', { variant: 'ghost', onClick: () => { i++; draw(); } })));
  };
  draw();
  openModal({ title: 'Send reading requests', body, footer: [button('Close', { onClick: closeModal })], onClose: rerender });
}

// Which calendar the reminders go to: Google Calendar (default — one
// "add" link per flat) or a downloaded .ics file (Outlook / Apple).
const calendarApp = () => (state.db.settings?.electricity?.calendarApp === 'file' ? 'file' : 'google');
const calendarButtonLabel = () => (calendarApp() === 'google' ? 'Add to Google Calendar' : 'Add to calendar');
// Per flat, what its reminders looked like when last added to the calendar
// (buildCalendar hashes) — a flat whose hash differs is missing or stale.
const savedHashes = () => state.db.settings?.electricity?.calendarHashes || {};
const saveCalendarHashes = cal => {
  state.db.settings.electricity = { ...(state.db.settings.electricity || {}), calendarHashes: { ...savedHashes(), ...cal.hashes }, calendarExportedAt: todayYmd() };
  markDirty();
};
const staleFlats = cal => Object.keys(cal.hashes).filter(id => savedHashes()[id] !== cal.hashes[id]);

// Add the reading + invoice reminders of the given flats (all when omitted).
// Google Calendar: everything at once by importing one file on the Google
// Calendar website, or event by event with pre-filled "add" links.
function addToCalendar(rerender, propertyIds = null, title = null) {
  const cal = buildCalendar(appBaseUrl(), todayYmd(), { propertyIds });
  if (!cal.events.length) { showSkipped(cal.skipped, 'No reminders to add yet'); return; }
  if (calendarApp() === 'file') return downloadCalendar(cal, rerender);
  const updating = Object.keys(cal.hashes).some(id => savedHashes()[id]);
  const body = el('div', {});
  body.appendChild(el('div', { style: 'font-size:13px;padding:10px 12px;border-radius:6px;background:var(--info-soft);margin-bottom:12px' },
    el('div', { style: 'font-weight:700;margin-bottom:4px' }, `All at once (${cal.events.length} events)`),
    el('div', { class: 'muted', style: 'margin-bottom:8px' }, 'Download the file, then on the Google Calendar website: ⚙ Settings → Import & export → Import → choose the file → Import.'),
    button('Download file for Google Calendar', { variant: 'sm primary', onClick: () => { saveFile(cal); toast('File downloaded — import it in Google Calendar (Settings → Import & export)', 'success', 7000); } })));
  body.appendChild(el('div', { class: 'muted', style: 'font-size:13px;margin-bottom:6px' },
    'Or one by one: each Add opens Google Calendar with the repeating reminder filled in — press Save.' +
    (updating ? ' Updating? Delete the old events of these flats first (open one → Delete → All events), so they aren\'t doubled.' : '')));
  for (const ev of cal.events) {
    const a = el('a', { href: ev.google, target: '_blank', rel: 'noopener', class: 'btn sm', style: 'text-decoration:none' }, 'Add');
    a.onclick = () => { a.textContent = '✓ Opened'; };
    const what = ev.kind === 'reading'
      ? `Reading request · ${ev.tenant.name} · ${ev.via === 'whatsapp' ? 'WhatsApp' : ev.via === 'viber' ? 'Viber' : 'Email'} · ${MESSAGE_LANGUAGES[langOf(ev.tenant)]}`
      : `Invoice check & pay${ev.provider ? ` · ${ev.provider.name}${ev.provider.website ? ' (with website link)' : ' — add its website under Vendors to get the link'}` : ''}`;
    body.appendChild(el('div', { style: 'display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px' },
      el('div', { style: 'flex:1' }, el('strong', {}, ev.property.name), el('span', { class: 'muted' }, ` · ${what}`)), a));
  }
  if (cal.skipped.length) {
    body.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-top:12px' }, 'Left out:'));
    for (const s of cal.skipped) body.appendChild(el('div', { class: 'muted', style: 'font-size:12px' }, `${s.property.name} — ${s.reason}`));
  }
  openModal({ title: title || 'Add reminders to Google Calendar', body, footer: [
    button('Later', { onClick: closeModal }),
    button('Done — added', { variant: 'primary', onClick: () => { saveCalendarHashes(cal); closeModal(); rerender(); } })
  ] });
}

function saveFile(cal) {
  const a = el('a', { href: URL.createObjectURL(new Blob([cal.ics], { type: 'text/calendar' })), download: 'electricity-reminders.ics' });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function downloadCalendar(cal, rerender) {
  saveFile(cal);
  saveCalendarHashes(cal);
  toast(`Calendar file with ${cal.events.length} reminder(s) downloaded — open it on your phone to add it to your calendar`, 'success', 7000);
  if (cal.skipped.length) showSkipped(cal.skipped, `${cal.events.length} reminder(s) downloaded — note`);
  rerender();
}

// Which flats got no reminder, and why.
function showSkipped(skipped, title) {
  const body = el('div', {});
  body.appendChild(el('div', { class: 'muted', style: 'font-size:13px;margin-bottom:8px' },
    'A flat gets a reminder once it has a reading window (set up at the bottom of this page) and a current tenant with a phone number or email.'));
  for (const s of skipped) {
    body.appendChild(el('div', { style: 'display:flex;gap:10px;padding:5px 0;border-bottom:1px solid var(--border);font-size:13px' },
      el('div', { style: 'font-weight:600;min-width:180px' }, s.property.name), el('div', { class: 'muted' }, s.reason)));
  }
  if (!skipped.length) body.appendChild(el('div', { class: 'muted' }, 'No Hungarian properties found.'));
  openModal({ title, body, footer: [button('Close', { onClick: closeModal })] });
}

let _filter = 'all';      // all | action | overdue | open | invoice | awaiting | paid | done
let _history = false;
let _accountId = null;     // account messages are sent from (this session)

const VIA_LABEL = { whatsapp: 'WhatsApp', viber: 'Viber', email: 'Email', call: 'Call' };
const STEP_BADGE = {
  upcoming: ['', 'Upcoming'], open: ['warning', 'Window open'], overdue: ['danger', 'Overdue'],
  waiting: ['', 'After the reading'], due: ['warning', 'Check & pay'], done: ['success', 'Done']
};
const badge = s => el('span', { class: `badge ${STEP_BADGE[s][0]}` }, STEP_BADGE[s][1]);
const link = (text, onClick, color = 'var(--accent,#6366f1)') => {
  const a = el('span', { style: `color:${color};cursor:pointer;text-decoration:underline;font-size:11px;margin-left:6px` }, text);
  a.onclick = onClick;
  return a;
};

function build() {
  const wrap = el('div', { class: 'view active' });
  const rerender = () => { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); };
  const today = todayYmd();
  const applied = applySentMarks(today);
  if (applied) setTimeout(() => toast(`${applied} reading request(s) sent from calendar links marked as sent`, 'info'), 0);
  const props = electricityProperties();
  if (!props.length) {
    wrap.appendChild(el('div', { class: 'empty' }, 'No Hungarian properties — this tracker covers properties whose country is Hungary.'));
    return wrap;
  }

  // ── Summary of the current cycle per property ──
  let rDone = 0, iDone = 0, n = 0;
  for (const p of props) {
    const cur = [...cyclesFor(p, today)].reverse().find(c => c.windowFrom <= today);
    if (!cur || cur.excluded) continue;
    n++;
    if (cur.reading === 'done') rDone++;
    if (cur.invoice === 'done') iDone++;
  }
  // Open / overdue steps across every cycle (not just the current one) —
  // each counter filters the table to those rows.
  const all = electricityRows(today).filter(c => !c.excluded);
  const month = today.slice(0, 7);
  const paidThisMonth = listActive('electricityCycles').filter(r => (r.paidAt || '').startsWith(month)).length;
  const counters = [
    { key: 'overdue', label: 'Readings overdue', n: all.filter(c => c.reading === 'overdue').length, color: 'var(--danger)' },
    { key: 'open', label: 'Readings to submit now', n: all.filter(c => c.reading === 'open').length, color: 'var(--warning)' },
    { key: 'invoice', label: 'Invoices to pay', n: all.filter(c => c.invoice === 'due').length, color: 'var(--warning)' },
    { key: 'awaiting', label: 'Invoices awaited', n: all.filter(c => c.invoice === 'upcoming').length, color: 'var(--text-muted)' },
    { key: 'paid', label: 'Paid this month', n: paidThisMonth, color: 'var(--success)' }
  ];
  const summary = el('div', { class: 'card mb-16', style: 'padding:12px 16px' });
  const chips = el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' });
  for (const k of counters) {
    const active = _filter === k.key;
    const chip = el('div', {
      style: `cursor:pointer;padding:8px 14px;border-radius:8px;border:1px solid ${active ? k.color : 'var(--border)'};min-width:120px;${active ? 'background:var(--bg-alt,rgba(0,0,0,.04))' : ''}`,
      title: active ? 'Click again to show all' : 'Show these rows'
    }, el('div', { style: `font-size:20px;font-weight:700;color:${k.n ? k.color : 'var(--text-muted)'}` }, String(k.n)),
       el('div', { class: 'muted', style: 'font-size:12px' }, k.label));
    chip.onclick = () => { _filter = active ? 'all' : k.key; rerender(); };
    chips.appendChild(chip);
  }
  summary.appendChild(chips);
  summary.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
    `Current cycle: ${rDone}/${n} readings submitted · ${iDone}/${n} invoices paid`));
  wrap.appendChild(summary);

  // Calendar reminders: offer the download, and flag a file that no longer
  // matches (window, tenant, number or message changed since).
  const cal = buildCalendar(appBaseUrl(), today);
  const stale = staleFlats(cal);
  if (stale.length) {
    const names = stale.map(id => byId('properties', id)?.name).filter(Boolean);
    const outdated = stale.filter(id => savedHashes()[id]).length;
    wrap.appendChild(el('div', { class: 'card mb-16', style: 'padding:10px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;font-size:13px;border-left:3px solid var(--info)' },
      el('span', { style: 'flex:1;min-width:220px' },
        `📅 Calendar reminders (reading request + invoice payment) ${outdated ? 'missing or out of date' : 'not added yet'} for: ${names.join(', ')}.`),
      button(outdated ? (calendarApp() === 'google' ? 'Update Google Calendar' : 'Download updated calendar') : calendarButtonLabel(),
        { variant: 'sm primary', onClick: () => addToCalendar(rerender, stale) })));
  }

  // ── Filters + sender account ──
  const s = messagingSettings();
  if (_accountId === null || !s.accounts.some(a => a.id === _accountId)) _accountId = s.defaultAccountId || s.accounts[0]?.id || '';
  const bar = el('div', { class: 'flex gap-8 mb-16', style: 'flex-wrap:wrap;align-items:center' });
  const filterS = select([
    { value: 'all', label: 'All open & upcoming' }, { value: 'action', label: 'Needs action' },
    { value: 'overdue', label: 'Readings overdue' }, { value: 'open', label: 'Readings to submit now' },
    { value: 'invoice', label: 'Invoices to pay' }, { value: 'awaiting', label: 'Invoices awaited' },
    { value: 'paid', label: 'Paid this month' }, { value: 'done', label: 'Done' }
  ], _filter);
  filterS.onchange = () => { _filter = filterS.value; rerender(); };
  filterS.style.width = 'auto';
  const histChk = el('input', { type: 'checkbox', id: 'elecHist' });
  histChk.checked = _history;
  histChk.onchange = () => { _history = histChk.checked; rerender(); };
  bar.appendChild(filterS);
  bar.appendChild(el('label', { for: 'elecHist', style: 'display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer' }, histChk, 'Show history'));
  bar.appendChild(el('div', { class: 'flex-1' }));
  if (s.accounts.length) {
    const accS = select(s.accounts.map(a => ({ value: a.id, label: `${a.label} · ${VIA_LABEL[a.channel] || a.channel}${a.contact ? ` (${a.contact})` : ''}` })), _accountId);
    accS.onchange = () => { _accountId = accS.value; };
    accS.style.width = 'auto';
    bar.appendChild(el('span', { class: 'muted', style: 'font-size:12px' }, 'Send messages from'));
    bar.appendChild(accS);
  }
  const due = dueMessages(today);
  if (due.length) bar.appendChild(button(`Send all due (${due.length})`, { variant: 'sm primary', onClick: () => openSendAll(due, rerender) }));
  bar.appendChild(button(calendarButtonLabel(), { variant: 'sm ghost', onClick: () => addToCalendar(rerender) }));
  bar.appendChild(button('Messages & provider', { variant: 'sm ghost', onClick: () => openMessagingSettings(rerender) }));
  wrap.appendChild(bar);

  // ── Tracker table ──
  let rows = electricityRows(today, { history: _history });
  if (_filter === 'action') rows = rows.filter(c => !c.excluded && (['open', 'overdue'].includes(c.reading) || c.invoice === 'due'));
  if (_filter === 'done') rows = rows.filter(c => c.complete && !c.excluded);
  if (_filter === 'overdue') rows = rows.filter(c => !c.excluded && c.reading === 'overdue');
  if (_filter === 'open') rows = rows.filter(c => !c.excluded && c.reading === 'open');
  if (_filter === 'invoice') rows = rows.filter(c => !c.excluded && c.invoice === 'due');
  if (_filter === 'awaiting') rows = rows.filter(c => !c.excluded && c.invoice === 'upcoming');
  if (_filter === 'paid') rows = electricityRows(today, { history: true }).filter(c => (c.record?.paidAt || '').startsWith(today.slice(0, 7)));
  const tableWrap = el('div', { class: 'table-wrap mb-16' });
  if (!rows.length) tableWrap.appendChild(el('div', { class: 'empty' }, 'No cycles match'));
  else {
    const t = el('table', { class: 'table' });
    const htr = el('tr');
    for (const h of ['Property', 'Period', 'Tenant', '① Reading submitted', '② Invoice checked & paid', 'Message tenant']) htr.appendChild(el('th', {}, h));
    t.appendChild(el('thead', {}, htr));
    const tb = el('tbody');
    for (const c of rows) tb.appendChild(renderRow(c, today, rerender));
    t.appendChild(tb);
    tableWrap.appendChild(t);
  }
  wrap.appendChild(tableWrap);

  // ── Properties: set-up of the reading window ──
  const setupCard = el('div', { class: 'card' });
  setupCard.appendChild(el('div', { class: 'card-header' }, el('div', {},
    el('div', { class: 'card-title' }, 'Reading windows'),
    el('div', { class: 'card-subtitle' }, 'When each flat\'s meter reading can be submitted, how often, and how long the provider takes to post the invoice'))));
  const list = el('div', { style: 'padding:0 16px 12px' });
  for (const p of props) {
    const cfg = elecConfig(p);
    const desc = !cfg ? 'Not set up'
      : cfg.active === false ? 'Off'
      : `Day ${cfg.windowFrom}–${cfg.windowTo} · every ${Number(cfg.everyMonths) > 1 ? `${cfg.everyMonths} months` : 'month'} from ${cfg.startMonth} · invoice ~${cfg.invoiceDelayDays} days after`;
    list.appendChild(el('div', { style: 'display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px' },
      el('div', { style: 'font-weight:600;min-width:180px' }, p.name),
      el('div', { class: cfg ? '' : 'muted', style: 'flex:1' }, desc),
      button(cfg ? 'Edit' : 'Set up', { variant: cfg ? 'sm ghost' : 'sm primary', onClick: () => openSetup(p, rerender) })));
  }
  setupCard.appendChild(list);
  wrap.appendChild(setupCard);
  return wrap;
}

function renderRow(c, today, rerender) {
  const p = c.property;
  const tr = el('tr', c.excluded ? { style: 'opacity:.55' } : {});
  tr.appendChild(el('td', { style: 'font-weight:500' }, p.name));
  tr.appendChild(el('td', {}, c.period, el('div', { class: 'muted', style: 'font-size:11px' }, `window ${fmtDate(c.windowFrom)} – ${fmtDate(c.windowTo)}`)));
  tr.appendChild(el('td', {}, c.tenant?.name || el('span', { class: 'muted' }, 'No tenant')));
  if (c.excluded) {
    tr.appendChild(el('td', { colspan: 3, class: 'muted' }, 'Tenant pays the electricity directly — not tracked'));
    return tr;
  }
  const rec = c.record || {};

  // ① Reading
  const r = el('td', {});
  if (c.reading === 'done') {
    r.appendChild(el('span', { style: 'color:var(--success)' }, `✓ ${fmtDate(rec.readingAt)}${rec.kwh != null ? ` · ${rec.kwh} kWh` : ''}`));
    if (c.invoice !== 'done') r.appendChild(link('Undo', () => { undoReading(c); rerender(); }));
  } else {
    r.appendChild(badge(c.reading));
    if (c.reading !== 'upcoming') r.appendChild(el('div', { style: 'margin-top:4px' }, button('Mark submitted', { variant: 'sm primary', onClick: () => openReadingModal(c, rerender) })));
  }
  tr.appendChild(r);

  // ② Invoice
  const iv = el('td', {});
  if (c.invoice === 'done') {
    iv.appendChild(el('span', { style: 'color:var(--success)' }, `✓ ${formatMoney(rec.invoiceAmount, rec.invoiceCurrency || p.currency || 'HUF', { maxFrac: 0 })} paid ${fmtDate(rec.paidAt)}`));
    iv.appendChild(link('Undo', () => { undoInvoice(c); toast('Invoice unmarked — its expense was removed', 'info'); rerender(); }));
  } else if (c.invoice === 'waiting') {
    iv.appendChild(el('span', { class: 'muted' }, 'After the reading'));
  } else {
    iv.appendChild(badge(c.invoice));
    iv.appendChild(el('div', { class: 'muted', style: 'font-size:11px' }, `${c.invoice === 'due' ? 'expected since' : 'expected around'} ${fmtDate(c.invoiceDue)}`));
    iv.appendChild(el('div', { style: 'margin-top:4px' }, button('Mark paid', { variant: c.invoice === 'due' ? 'sm primary' : 'sm ghost', onClick: () => openInvoiceModal(c, rerender) })));
  }
  tr.appendChild(iv);

  // Message to the tenant asking for the reading
  const m = el('td', {});
  if (rec.messagedAt) m.appendChild(el('div', { class: 'muted', style: 'font-size:12px' }, `Sent ${fmtDate(rec.messagedAt)} via ${VIA_LABEL[rec.messagedVia] || rec.messagedVia}${rec.messagedFrom === 'calendar' ? ' (calendar link)' : ''}`));
  if (c.messageable) {
    const text = messageFor(c);
    const ml = messageLink(c.tenant, text);
    if (!ml) m.appendChild(el('span', { class: 'muted', style: 'font-size:12px' }, 'No phone/email on the tenant'));
    else {
      m.appendChild(button(`${rec.messagedAt ? 'Send again' : 'Send'} (${VIA_LABEL[ml.via]})`, { variant: rec.messagedAt ? 'sm ghost' : 'sm', onClick: async () => {
        await sendTo(c);
        rerender();
      } }));
    }
  } else if (!rec.messagedAt) {
    m.appendChild(el('span', { class: 'muted', style: 'font-size:12px' }, c.reading === 'done' ? '—' : c.tenant ? `can send from ${fmtDate(addDaysYmd(c.windowFrom, -MESSAGE_LEAD_DAYS))}` : '—'));
  }
  tr.appendChild(m);
  return tr;
}

function openReadingModal(c, rerender) {
  const body = el('div', {});
  const dateI = input({ type: 'date', value: todayYmd() });
  const kwhI = input({ type: 'number', min: 0, step: 1, placeholder: 'Meter reading (kWh)' });
  const noteI = textarea({ placeholder: 'Optional note', rows: 2 });
  body.appendChild(el('div', { class: 'muted', style: 'margin-bottom:8px;font-size:13px' }, `${c.property.name} · ${c.period} · window ${fmtDate(c.windowFrom)} – ${fmtDate(c.windowTo)}`));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Submitted on', dateI), formRow('Meter reading (kWh)', kwhI)));
  body.appendChild(formRow('Note', noteI));
  openModal({ title: 'Reading submitted to the provider', body, footer: [
    button('Cancel', { onClick: closeModal }),
    button('Save', { variant: 'primary', onClick: () => {
      if (!dateI.value) { toast('Enter the date', 'warning'); return; }
      if (kwhI.value !== '' && !(Number(kwhI.value) >= 0)) { toast('Meter reading must be a positive number', 'warning'); return; }
      markReading(c, { date: dateI.value, kwh: kwhI.value, note: noteI.value.trim() });
      closeModal(); toast('Reading marked as submitted', 'success'); rerender();
    } })
  ] });
}

function openInvoiceModal(c, rerender) {
  const p = c.property;
  const body = el('div', {});
  const dateI = input({ type: 'date', value: todayYmd() });
  const amountI = input({ type: 'number', min: 0, step: 1 });
  const ccyS = select(CURRENCIES, p.currency || 'HUF');
  const noI = input({ placeholder: 'Optional' });
  // Vendor paid: the one on this cycle's expense if re-marking, else the
  // default provider; a new one can be added here without leaving the form.
  const defaultId = messagingSettings().providerVendorId;
  const prevExp = c.record?.expenseId ? byId('expenses', c.record.expenseId) : null;
  const vendorOpts = () => [{ value: '', label: '— no vendor —' },
    ...listActive('vendors').slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(v => ({ value: v.id, label: v.name }))];
  const vendorS = select(vendorOpts(), (prevExp && !prevExp.deletedAt ? prevExp.vendorId : defaultId) || '');
  const defChk = el('input', { type: 'checkbox', id: 'elecDefVendor' });
  const defRow = el('label', { for: 'elecDefVendor', style: 'display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;margin-top:4px' }, defChk, 'Use as the default provider for all flats');
  const syncDef = () => { defRow.style.display = vendorS.value && vendorS.value !== defaultId ? '' : 'none'; };
  vendorS.addEventListener('change', syncDef);
  const newI = input({ placeholder: 'New vendor name, e.g. E.ON' });
  const webI = input({ type: 'url', placeholder: 'Website / customer portal (optional)' });
  const addBox = el('div', { style: 'display:none;gap:6px;margin-top:6px;flex-wrap:wrap' }, newI, webI, button('Add', { variant: 'sm primary', onClick: () => {
    const name = newI.value.trim();
    if (!name) { toast('Enter the vendor name', 'warning'); return; }
    const website = normalizeWebsite(webI.value);
    if (website === null) { toast('Website must be a web address, e.g. https://www.eon.hu', 'warning'); return; }
    const existing = listActive('vendors').find(v => (v.name || '').trim().toLowerCase() === name.toLowerCase());
    const v = existing ? (website && !existing.website ? { ...existing, website } : existing) : { id: newId('vnd'), name, role: 'utility', ...(website ? { website } : {}) };
    if (!existing || v !== existing) upsert('vendors', v);
    vendorS.innerHTML = '';
    for (const o of vendorOpts()) vendorS.appendChild(el('option', { value: o.value }, o.label));
    vendorS.value = v.id;
    addBox.style.display = 'none';
    syncDef();
    toast(existing ? `${v.name} already exists — selected` : `Vendor ${v.name} added`, 'success');
  } }));
  const addLink = el('span', { style: 'color:var(--accent,#6366f1);cursor:pointer;text-decoration:underline;font-size:12px' }, '+ add vendor');
  addLink.onclick = () => { addBox.style.display = 'flex'; newI.focus(); };
  body.appendChild(el('div', { class: 'muted', style: 'margin-bottom:8px;font-size:13px' },
    `${p.name} · ${c.period} — saved as an Electricity expense on this property.`));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Amount', amountI), formRow('Currency', ccyS)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Paid on', dateI), formRow('Invoice no.', noI)));
  body.appendChild(formRow('Vendor (provider)', el('div', {}, vendorS, el('div', { style: 'margin-top:4px' }, addLink), addBox, defRow)));
  syncDef();
  openModal({ title: 'Invoice checked & paid', body, footer: [
    button('Cancel', { onClick: closeModal }),
    button('Save', { variant: 'primary', onClick: () => {
      const amt = Number(amountI.value);
      if (!(amt > 0)) { toast('Enter the invoice amount', 'warning'); return; }
      if (!dateI.value) { toast('Enter the payment date', 'warning'); return; }
      markInvoicePaid(c, { date: dateI.value, amount: amt, currency: ccyS.value, invoiceNo: noI.value.trim(), vendorId: vendorS.value });
      if (defChk.checked && vendorS.value) {
        state.db.settings.electricity = { ...(state.db.settings.electricity || {}), providerVendorId: vendorS.value };
        markDirty();
      }
      const vName = vendorS.value ? byId('vendors', vendorS.value)?.name : '';
      closeModal(); toast(`Invoice paid — Electricity expense added${vName ? ` (${vName})` : ''}`, 'success'); rerender();
    } })
  ] });
}

function openSetup(p, rerender) {
  const cfg = elecConfig(p) || { ...DEFAULT_ELEC_CONFIG, startMonth: todayYmd().slice(0, 7) };
  const body = el('div', {});
  const fromI = input({ type: 'number', min: 1, max: 31, value: cfg.windowFrom });
  const toI = input({ type: 'number', min: 1, max: 31, value: cfg.windowTo });
  const everyS = select([1, 2, 3, 6, 12].map(n => ({ value: String(n), label: n === 1 ? 'Every month' : `Every ${n} months` })), String(cfg.everyMonths || 1));
  const startI = input({ type: 'month', value: cfg.startMonth || todayYmd().slice(0, 7) });
  const delayI = input({ type: 'number', min: 0, max: 90, value: cfg.invoiceDelayDays });
  const activeChk = el('input', { type: 'checkbox', id: 'elecActive' });
  activeChk.checked = cfg.active !== false;
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Window opens (day)', fromI), formRow('Window closes (day)', toI)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Repeats', everyS), formRow('First reading month', startI)));
  body.appendChild(formRow('Invoice arrives (days after the reading)', delayI));
  body.appendChild(el('label', { for: 'elecActive', style: 'display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin-top:6px' }, activeChk, 'Track this property'));
  openModal({ title: `Reading window — ${p.name}`, body, footer: [
    button('Cancel', { onClick: closeModal }),
    button('Save', { variant: 'primary', onClick: () => {
      const f = Math.floor(Number(fromI.value)), t = Math.floor(Number(toI.value)), d = Math.floor(Number(delayI.value));
      if (!(f >= 1 && f <= 31 && t >= 1 && t <= 31)) { toast('Window days must be between 1 and 31', 'warning'); return; }
      if (t < f) { toast('The window can\'t close before it opens', 'warning'); return; }
      if (!/^\d{4}-\d{2}$/.test(startI.value)) { toast('Choose the first reading month', 'warning'); return; }
      if (!(d >= 0 && d <= 90)) { toast('Invoice delay must be 0–90 days', 'warning'); return; }
      upsert('properties', { ...byId('properties', p.id), electricity: {
        active: activeChk.checked, windowFrom: f, windowTo: t, everyMonths: Number(everyS.value), startMonth: startI.value, invoiceDelayDays: d
      } });
      closeModal(); toast('Reading window saved', 'success'); rerender();
      // Straight on to this flat's calendar reminders (reading + invoice).
      if (activeChk.checked) setTimeout(() => addToCalendar(rerender, [p.id], `Add ${p.name} reminders to ${calendarApp() === 'google' ? 'Google Calendar' : 'your calendar'}`), 300);
    } })
  ] });
}

// Accounts messages go out from, the message text and the electricity provider (vendor).
function openMessagingSettings(rerender) {
  const cur = messagingSettings();
  let accounts = cur.accounts.map(a => ({ ...a }));
  const body = el('div', {});
  body.appendChild(el('div', { style: 'font-size:12px;padding:8px 10px;border-radius:6px;background:var(--info-soft);margin-bottom:10px' },
    'Messages open in WhatsApp / Viber / your email app with the text ready — you press send. They go out from the account logged in on the device you click from, so pick the account here to keep track of which one you used. (Fully automatic sending needs a WhatsApp Business API account.)'));
  const accHost = el('div', {});
  const defS = select([], cur.defaultAccountId);
  const renderAccounts = () => {
    accHost.innerHTML = '';
    accounts.forEach((a, i) => {
      const labelI = input({ value: a.label || '', placeholder: 'e.g. Company phone' });
      const chS = select([{ value: 'whatsapp', label: 'WhatsApp' }, { value: 'viber', label: 'Viber' }, { value: 'email', label: 'Email' }], a.channel || 'whatsapp');
      const numI = input({ value: a.contact || '', placeholder: '+36 30 … / email' });
      labelI.oninput = () => { a.label = labelI.value; syncDefault(); };
      chS.onchange = () => { a.channel = chS.value; };
      numI.oninput = () => { a.contact = numI.value; };
      accHost.appendChild(el('div', { style: 'display:flex;gap:6px;margin-bottom:6px;align-items:center' }, labelI, chS, numI,
        button('✕', { variant: 'sm ghost', onClick: () => { accounts.splice(i, 1); renderAccounts(); } })));
    });
    syncDefault();
  };
  const syncDefault = () => {
    const v = defS.value || cur.defaultAccountId;
    defS.innerHTML = '';
    for (const a of accounts) defS.appendChild(el('option', { value: a.id }, a.label || '(unnamed)'));
    if (accounts.some(a => a.id === v)) defS.value = v;
  };
  body.appendChild(el('div', { class: 'form-label' }, 'Send-from accounts'));
  body.appendChild(accHost);
  body.appendChild(button('+ Add account', { variant: 'sm ghost', onClick: () => { accounts.push({ id: newId('acc'), label: '', channel: 'whatsapp', contact: '' }); renderAccounts(); } }));
  body.appendChild(formRow('Default account', defS));
  // One message per language; each tenant's form says which one they get.
  const tplTs = {};
  for (const [lang, label] of Object.entries(MESSAGE_LANGUAGES)) {
    tplTs[lang] = textarea({ rows: 3 });
    tplTs[lang].value = cur.templates[lang];
    body.appendChild(formRow(`Reading request message — ${label}`, tplTs[lang], lang === 'en'
      ? 'Placeholders: {tenant} (first name), {property}, {from}, {to} (the reading window). Each tenant gets the language set in their tenant form.'
      : 'Ugyanazok a helyőrzők: {tenant}, {property}, {from}, {to}.'));
  }
  const provS = select([{ value: '', label: '— none —' }, ...listActive('vendors').map(v => ({ value: v.id, label: v.name }))], cur.providerVendorId);
  body.appendChild(formRow('Electricity provider (vendor on the expense)', provS));
  const calS = select([{ value: 'google', label: 'Google Calendar' }, { value: 'file', label: 'Outlook / Apple (download a calendar file)' }], calendarApp());
  body.appendChild(formRow('Calendar for reminders', calS));
  renderAccounts();
  openModal({ title: 'Messages & provider', body, footer: [
    button('Cancel', { onClick: closeModal }),
    button('Save', { variant: 'primary', onClick: () => {
      const clean = accounts.map(a => ({ ...a, label: (a.label || '').trim(), contact: (a.contact || '').trim() })).filter(a => a.label || a.contact);
      state.db.settings.electricity = { ...(state.db.settings.electricity || {}),
        accounts: clean, defaultAccountId: clean.some(a => a.id === defS.value) ? defS.value : (clean[0]?.id || ''),
        templates: Object.fromEntries(Object.keys(MESSAGE_LANGUAGES).map(l => [l, tplTs[l].value.trim() || cur.templates[l]])), providerVendorId: provS.value, calendarApp: calS.value };
      markDirty();
      closeModal(); toast('Saved', 'success'); rerender();
    } })
  ] });
}
