// App side of the GitHub calendar sync (js/core/calsync.js, docs/calendar-sync.md):
// shares the calendar links with the workflow (ical-sources.json), reads what
// it fetched (calendars.json) into strCalendars for every property, asks for
// a run on "Refresh", and reports anything wrong — not set up, waiting for the
// first run, key mismatch, a calendar that failed or went stale.
import { state, markDirty } from '../core/state.js';
import { el, openModal, closeModal, toast, button, fmtDate } from '../core/ui.js';
import { listActive, byId, upsert, newId } from '../core/data.js';
import { mergeBlocksChecked } from '../core/ical.js';
import { fetchGithubFile, uploadGithubFile, dispatchRepoEvent } from '../core/github.js';
import { isUnlocked } from '../core/crypto.js';
import { todayYmd } from '../core/dates.js';
import { CALSYNC, syncPath, generateCalendarKey, calendarKeyId, encryptCalendarJson, decryptCalendarJson, syncState } from '../core/calsync.js';

export const calSyncSettings = () => state.db.settings?.calendarSync || {};
const saveSettings = patch => {
  state.db.settings.calendarSync = { ...calSyncSettings(), ...patch };
  markDirty();
};
const canTalkToGithub = () => !!(state.github.owner && state.github.repo && state.github.token && isUnlocked());
const strProps = () => listActive('properties').filter(p => p.type === 'short_term' && p.status !== 'sold');
const calendarOf = id => (state.db.strCalendars || []).find(c => c.propertyId === id && !c.deletedAt) || null;
// The property's current link wins: a replaced Airbnb link must not keep
// fetching the old (revoked) one stored with the calendar.
const linkOf = p => p.airbnbCalUrl || calendarOf(p.id)?.url || '';

// Result of the last read of calendars.json, for the banner:
// { state: 'off' | 'waiting' | 'ok' | 'keyMismatch' | 'error', message?, checkedAt?, at }
let _last = null;
let _pulling = null;
let _refreshPoll = null;
export const lastPull = () => _last;

const strHash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
const b64Json = obj => btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
const fromB64Json = b64 => JSON.parse(decodeURIComponent(escape(atob(String(b64).replace(/\s/g, '')))));

// Share the calendar links with the workflow when they changed (or `force`).
export async function pushCalendarSources({ force = false } = {}) {
  const key = calSyncSettings().secretKey;
  if (!key || !canTalkToGithub()) return false;
  const sources = strProps().map(p => ({ propertyId: p.id, url: linkOf(p) })).filter(s => /^https:\/\//i.test(s.url))
    .sort((a, b) => a.propertyId.localeCompare(b.propertyId));
  const hash = strHash(JSON.stringify(sources) + (await calendarKeyId(key)));
  if (!force && calSyncSettings().sourcesHash === hash) return false;
  const path = syncPath(state.github.dbPath, CALSYNC.sourcesFile);
  await uploadGithubFile(path, b64Json(await encryptCalendarJson({ v: 1, sources }, key, path)), 'Update calendar sync sources');
  saveSettings({ sourcesHash: hash });
  return true;
}

// Read calendars.json and bring every property's calendar up to date.
export async function pullSyncedCalendars() {
  if (_pulling) return _pulling;
  _pulling = (async () => {
    const key = calSyncSettings().secretKey;
    if (!key) return (_last = { state: 'off', at: Date.now() });
    if (!state.github.owner || !state.github.repo) return (_last = { state: 'error', message: 'GitHub is not connected', at: Date.now() });
    const path = syncPath(state.github.dbPath, CALSYNC.calendarsFile);
    let doc;
    try {
      const file = await fetchGithubFile(path);
      doc = await decryptCalendarJson(fromB64Json(file.content), key, path);
    } catch (e) {
      if (/not found/i.test(e.message || '')) return (_last = { state: 'waiting', at: Date.now() });
      if (e.code === 'KEY_MISMATCH' || e.name === 'OperationError') return (_last = { state: 'keyMismatch', at: Date.now() });
      return (_last = { state: 'error', message: e.message || String(e), at: Date.now() });
    }
    applySyncedCalendars(doc);
    return (_last = { state: 'ok', checkedAt: doc.checkedAt, at: Date.now() });
  })();
  try { return await _pulling; } finally { _pulling = null; }
}

// Merge a decrypted calendars.json into strCalendars. A record is written only
// when the workflow fetched again (fetchedAt moved) or the error changed.
export function applySyncedCalendars(doc, today = todayYmd()) {
  let changed = 0;
  for (const [propertyId, c] of Object.entries(doc?.calendars || {})) {
    if (!byId('properties', propertyId)) continue;
    const rec = calendarOf(propertyId);
    const err = c.error || null;
    const fetchedMoved = c.fetchedAt && c.fetchedAt !== rec?.syncedAt;
    if (!fetchedMoved && err === (rec?.syncError || null) && rec?.syncCheckedAt === doc.checkedAt) continue;
    let blocks = rec?.blocks || [];
    if (fetchedMoved) blocks = mergeBlocksChecked(rec?.blocks, c.blocks || [], today, { allowSharpDrop: true }).blocks;
    const p = byId('properties', propertyId);
    upsert('strCalendars', {
      ...(rec || { id: newId('stc'), propertyId }),
      url: p?.airbnbCalUrl || rec?.url || '',
      blocks,
      ...(fetchedMoved ? { importedAt: c.fetchedAt.slice(0, 10), syncedAt: c.fetchedAt } : {}),
      syncError: err,
      syncCheckedAt: doc.checkedAt || null
    });
    changed++;
  }
  return changed;
}

// Push sources if they changed, then read the latest result. Called at start-
// up, every 30 minutes and when STR Daily Rates opens (all properties at once).
export async function calendarSyncTick() {
  try { await pushCalendarSources(); } catch (e) { console.warn('[calsync] could not share calendar links:', e.message); }
  return pullSyncedCalendars();
}

// "Refresh": ask GitHub for a run now, then watch for the result.
export async function refreshNow(onUpdate) {
  if (!calSyncSettings().secretKey) { openSetup(onUpdate); return; }
  try { await pushCalendarSources({ force: true }); } catch (e) { toast(`Could not share the calendar links with GitHub: ${e.message}`, 'danger', 8000); return; }
  const ok = await dispatchRepoEvent(CALSYNC.event);
  if (!ok) { toast('GitHub refused to start the calendar sync (check the token in Settings → GitHub). It still runs on its own every 30 minutes.', 'danger', 10000); return; }
  toast('Asked GitHub to fetch the Airbnb calendars now — usually done within a minute or two.', 'info', 7000);
  pullSyncedCalendars().then(() => onUpdate?.(), () => {});
  const startedAt = Date.now();
  const before = _last?.checkedAt || '';
  clearInterval(_refreshPoll);
  _refreshPoll = setInterval(async () => {
    const r = await pullSyncedCalendars();
    const done = r.state === 'ok' && r.checkedAt && r.checkedAt !== before && Date.parse(r.checkedAt) > startedAt - 60e3;
    if (done || Date.now() - startedAt > 4 * 60e3) {
      clearInterval(_refreshPoll);
      if (done) {
        // Say exactly which properties didn't sync, and why.
        const failed = calendarSyncProblems().filter(x => x.kind === 'error');
        if (failed.length) toast(`Airbnb calendars updated, but ${failed.length} didn't sync — ${failed.map(x => `${x.prop.name}: ${x.text.replace(/^Airbnb calendar sync failed: /, '')}`).join(' · ')}`, 'danger', 15000);
        else toast('All Airbnb calendars updated', 'success');
      }
      else toast('GitHub hasn\'t finished the calendar sync yet — check the "Sync Airbnb calendars" run under GitHub → Actions.', 'warning', 10000);
      onUpdate?.();
    }
  }, 20e3);
}

// Sync status of one property, for the line under its calendar and the flags.
export function propertySyncStatus(propertyId) {
  const rec = calendarOf(propertyId);
  if (!calSyncSettings().secretKey) return { state: 'off' };
  if (!rec?.syncedAt && !rec?.syncError) return { state: 'never' };
  const st = syncState({ fetchedAt: rec.syncedAt, error: rec.syncError, checkedAt: rec.syncCheckedAt || rec.syncedAt });
  return { state: st, syncedAt: rec.syncedAt, checkedAt: rec.syncCheckedAt, error: rec.syncError };
}

// Problems to flag across every short-term property with a calendar link.
export function calendarSyncProblems() {
  const props = strProps().filter(p => linkOf(p));
  if (!props.length) return [];
  if (!calSyncSettings().secretKey) return [{ kind: 'off', text: 'Airbnb calendars aren\'t syncing automatically — set it up in STR Daily Rates' }];
  const out = [];
  for (const p of props) {
    const s = propertySyncStatus(p.id);
    if (s.state === 'error') out.push({ kind: 'error', prop: p, text: `Airbnb calendar sync failed: ${s.error}` });
    else if (s.state === 'never') out.push({ kind: 'never', prop: p, text: 'Airbnb calendar not synced yet' });
    else if (s.state === 'stale') out.push({ kind: 'stale', prop: p, text: `Airbnb calendar not synced since ${new Date(s.syncedAt).toLocaleString()}` });
  }
  return out;
}

const ago = iso => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60e3);
  return m < 60 ? `${Math.max(1, m)} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : fmtDate(iso.slice(0, 10));
};

// Banner at the top of STR Daily Rates: not set up / waiting / key mismatch /
// failing or stale calendars. Empty when all is well.
export function renderSyncBanner(container, onUpdate) {
  container.innerHTML = '';
  const props = strProps().filter(p => linkOf(p));
  if (!props.length) return;
  const card = (color, ...kids) => el('div', { class: 'card', style: `margin-bottom:12px;padding:10px 14px;border-left:3px solid ${color};display:flex;gap:12px;align-items:center;flex-wrap:wrap;font-size:13px` }, ...kids);
  const s = calSyncSettings();
  if (!s.secretKey) {
    container.appendChild(card('#ef4444',
      el('span', { style: 'flex:1;min-width:240px' }, '⚠ Airbnb calendars aren\'t syncing automatically, so new bookings may be missing here and on the website. Set up the GitHub calendar sync (2 minutes).'),
      button('Set up calendar sync', { variant: 'sm primary', onClick: () => openSetup(onUpdate) })));
    return;
  }
  const last = _last;
  if (last?.state === 'keyMismatch') {
    container.appendChild(card('#ef4444', el('span', { style: 'flex:1;min-width:240px' }, '⚠ The calendar key in GitHub doesn\'t match the app\'s — the calendars can\'t be read. Copy the key again into the CALENDAR_SYNC_KEY secret.'),
      button('Show the key', { variant: 'sm primary', onClick: () => openSetup(onUpdate) })));
    return;
  }
  if (last?.state === 'error') {
    container.appendChild(card('#ef4444', el('span', { style: 'flex:1;min-width:240px' }, `⚠ Couldn't read the synced calendars: ${last.message}`),
      button('Retry', { variant: 'sm', onClick: async () => { await pullSyncedCalendars(); onUpdate?.(); } })));
    return;
  }
  // Set up but nothing synced yet (whatever the last read said).
  if (!props.some(p => calendarOf(p.id)?.syncedAt || calendarOf(p.id)?.syncError)) {
    container.appendChild(card('#f59e0b', el('span', { style: 'flex:1;min-width:240px' }, '⏳ Calendar sync is set up — waiting for its first run on GitHub (it runs every 30 minutes). If it never arrives, check that the CALENDAR_SYNC_KEY secret is set.'),
      button('Run it now', { variant: 'sm', onClick: () => refreshNow(onUpdate) }),
      button('Show the key', { variant: 'sm ghost', onClick: () => openSetup(onUpdate) })));
    return;
  }
  const problems = calendarSyncProblems();
  if (problems.length) {
    container.appendChild(card(problems.some(x => x.kind === 'error') ? '#ef4444' : '#f59e0b',
      el('div', { style: 'flex:1;min-width:240px' }, el('div', { style: 'font-weight:600' }, `⚠ Not synced from Airbnb: ${problems.map(x => x.prop?.name).filter(Boolean).join(', ')}`),
        ...problems.map(x => el('div', { class: 'muted', style: 'font-size:12px' }, `${x.prop?.name || ''}: ${x.text}`))),
      button('Refresh now', { variant: 'sm', onClick: () => refreshNow(onUpdate) })));
  }
}

// The line under a property's calendar: when it last synced, or what's wrong.
export function syncLine(propertyId, onUpdate) {
  const s = propertySyncStatus(propertyId);
  const wrap = el('div', { style: 'margin-top:4px;font-size:11px;display:flex;gap:8px;flex-wrap:wrap;align-items:center' });
  const refresh = el('span', { style: 'color:var(--accent,#6366f1);cursor:pointer;text-decoration:underline' }, 'Refresh now');
  refresh.onclick = () => refreshNow(onUpdate);
  if (s.state === 'off') return null;
  if (s.state === 'never') wrap.appendChild(el('span', { class: 'muted' }, 'Not synced from Airbnb yet.'));
  else if (s.state === 'error') wrap.appendChild(el('span', { style: 'color:var(--danger,#ef4444)' }, `Airbnb sync failed: ${s.error}${s.syncedAt ? ` · last good sync ${ago(s.syncedAt)}` : ''}`));
  else if (s.state === 'stale') wrap.appendChild(el('span', { style: 'color:var(--warning,#d97706)' }, `Not synced from Airbnb since ${ago(s.syncedAt)} — check the "Sync Airbnb calendars" run on GitHub.`));
  else wrap.appendChild(el('span', { class: 'muted' }, `Synced from Airbnb ${ago(s.syncedAt)} (GitHub, every 30 min).`));
  wrap.appendChild(refresh);
  return wrap;
}

// Setup: create the calendar key, show it to copy into the GitHub secret,
// share the links and start the first run.
export function openSetup(onUpdate) {
  let key = calSyncSettings().secretKey;
  if (!key) { key = generateCalendarKey(); saveSettings({ secretKey: key, setupAt: new Date().toISOString(), sourcesHash: '' }); }
  const { owner, repo } = state.github;
  const secretsUrl = owner && repo ? `https://github.com/${owner}/${repo}/settings/secrets/actions/new` : '';
  const body = el('div', { style: 'font-size:13px;line-height:1.5' });
  body.appendChild(el('div', { style: 'margin-bottom:10px' },
    'GitHub fetches your Airbnb calendars every 30 minutes (browsers can\'t), keeps them encrypted next to your data, and closes newly booked nights on the website — even when nobody has the app open. It needs one secret:'));
  const keyBox = el('input', { class: 'input', readonly: true, value: key, style: 'font-family:monospace;font-size:12px;width:100%' });
  keyBox.onclick = () => keyBox.select();
  body.appendChild(el('ol', { style: 'padding-left:18px;margin:0 0 10px' },
    el('li', {}, 'Open GitHub → your repository → Settings → Secrets and variables → Actions → ', secretsUrl ? el('a', { href: secretsUrl, target: '_blank', rel: 'noopener' }, 'New repository secret') : 'New repository secret', '.'),
    el('li', {}, 'Name: ', el('code', {}, CALSYNC.secretName)),
    el('li', {}, 'Secret: the calendar key below — then click "Add secret".')));
  body.appendChild(keyBox);
  body.appendChild(el('div', { style: 'margin-top:6px' }, button('Copy key', { variant: 'sm', onClick: async () => {
    try { await navigator.clipboard.writeText(key); toast('Calendar key copied', 'success'); } catch { keyBox.select(); toast('Select the key and copy it', 'warning'); }
  } })));
  body.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-top:10px' },
    'The calendar key only opens the calendar files — never your data. Treat it like a password: paste it only into that GitHub secret.'));
  openModal({ title: 'Automatic Airbnb calendar sync', body, footer: [
    button('Close', { onClick: closeModal }),
    button('Done — start the first sync', { variant: 'primary', onClick: async () => { closeModal(); await refreshNow(onUpdate); onUpdate?.(); } })
  ] });
}
