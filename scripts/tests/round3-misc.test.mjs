// iCal proxy policy, the dashboards' memoView, and the OCR worker's
// language-data fetch guard. Synthetic data only.
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { state, setDb } = await import('../../js/core/state.js');
const { upsert } = await import('../../js/core/data.js');
const { fetchICal } = await import('../../js/core/ical.js');
const { memoView, _clearViewMemo } = await import('../../js/modules/analytics-helpers.js');
const { _ocrInternals } = await import('../../js/core/libs.js');

const ICAL = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
const FEED = 'https://www.airbnb.example/calendar/ical/1.ics?s=synthetic';

function withFetch(handler, fn) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push(String(url)); return handler(String(url), init); };
  return fn(calls).finally(() => { globalThis.fetch = orig; });
}
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body });
function airbnbSettings(airbnb) {
  setDb({ ...structuredClone(state.db), settings: { ...(state.db.settings || {}), airbnb } });
}

test('iCal: private proxy configured → public proxies never see the link', async () => {
  airbnbSettings({ icalProxyUrl: 'https://own.workers.dev/' });
  await withFetch(url => url === FEED ? Promise.reject(new TypeError('CORS')) : resp(502, 'bad gateway'), async calls => {
    await assert.rejects(fetchICal(FEED), /Calendar proxy returned 502/);
    assert.deepEqual(calls, [FEED, 'https://own.workers.dev/']);
  });
});

test('iCal: private proxy + explicit opt-in → public proxies are a fallback', async () => {
  airbnbSettings({ icalProxyUrl: 'https://own.workers.dev/', icalPublicFallback: true });
  await withFetch(url => {
    if (url === FEED) return Promise.reject(new TypeError('CORS'));
    if (url.startsWith('https://own.workers.dev')) return resp(500, 'err');
    if (url.startsWith('https://corsproxy.io/')) return resp(200, ICAL);
    return resp(404, '');
  }, async calls => {
    assert.equal(await fetchICal(FEED), ICAL);
    assert.equal(calls[2].startsWith('https://corsproxy.io/'), true);
  });
});

test('iCal: an old-screen default (allowPublicIcalProxies: true) next to a private proxy does NOT enable public proxies', async () => {
  airbnbSettings({ icalProxyUrl: 'https://own.workers.dev/', allowPublicIcalProxies: true });
  await withFetch(url => {
    if (url === FEED) return Promise.reject(new TypeError('CORS'));
    if (url.startsWith('https://own.workers.dev')) return resp(500, 'err');
    return resp(200, ICAL);
  }, async calls => {
    await assert.rejects(fetchICal(FEED));
    assert.equal(calls.some(u => /corsproxy|allorigins|cors\.eu\.org/.test(u)), false);
  });
});

test('iCal: private proxy success is used directly', async () => {
  airbnbSettings({ icalProxyUrl: 'https://own.workers.dev/', allowPublicIcalProxies: true });
  await withFetch(url => url === FEED ? Promise.reject(new TypeError('CORS')) : resp(200, ICAL), async calls => {
    assert.equal(await fetchICal(FEED), ICAL);
    assert.equal(calls.length, 2);
  });
});

test('iCal: no private proxy → public proxies (unless explicitly switched off)', async () => {
  airbnbSettings({});
  await withFetch(url => url.startsWith('https://corsproxy.io/') ? resp(200, ICAL) : Promise.reject(new TypeError('x')), async calls => {
    assert.equal(await fetchICal(FEED), ICAL);
    assert.equal(calls.length, 2);
  });
  airbnbSettings({ allowPublicIcalProxies: false });
  await withFetch(() => Promise.reject(new TypeError('x')), async calls => {
    await assert.rejects(fetchICal(FEED), /public proxies are switched off/);
    assert.deepEqual(calls, [FEED]);
  });
});

test('memoView: tab switches reuse; data edits, dep changes and Set mutations recompute', () => {
  setDb({ ...structuredClone(state.db), expenses: [{ id: 'e1', amount: 1, date: '2026-01-01' }] });
  _clearViewMemo();
  let runs = 0;
  const filters = { streams: new Set(['a']), period: 'ytd' };
  const get = () => memoView('t', { filters, scope: 'company' }, () => ++runs);
  assert.equal(get(), 1);
  assert.equal(get(), 1);                 // same inputs: memoised
  filters.streams.add('b');               // in-place Set mutation (multi-selects do this)
  assert.equal(get(), 2);
  assert.equal(get(), 2);
  upsert('expenses', { id: 'e2', amount: 5, date: '2026-02-01' });
  assert.equal(get(), 3);                 // data edit
  upsert('vendors', { id: 'v1', name: 'V' }); // any collection invalidates
  assert.equal(get(), 4);
  state.db.settings = { ...(state.db.settings || {}) }; // settings swap
  assert.equal(get(), 5);
  assert.equal(memoView('t', { filters, scope: 'all' }, () => ++runs), 6);
  setDb(structuredClone(state.db));       // new db
  assert.equal(memoView('t', { filters, scope: 'all' }, () => ++runs), 7);
  // undefined vs missing deps are distinguished
  assert.equal(memoView('u', { a: undefined }, () => 'x'), 'x');
  assert.equal(memoView('u', {}, () => 'y'), 'y');
});

test('OCR fetch guard: pinned language data gets its integrity hash, others are refused', async () => {
  const files = { 'https://cdn.example/eng.traineddata.gz': 'sha384-abc' };
  const seen = [];
  const fakeSelf = { fetch: (url, init) => { seen.push([url, init]); return Promise.resolve('ok'); } };
  new Function('self', _ocrInternals.ocrFetchGuard(files))(fakeSelf);
  await fakeSelf.fetch('https://cdn.example/eng.traineddata.gz');
  assert.deepEqual(seen[0], ['https://cdn.example/eng.traineddata.gz', { integrity: 'sha384-abc', credentials: 'omit', cache: 'force-cache' }]);
  await assert.rejects(fakeSelf.fetch('https://evil.example/eng.traineddata.gz'), /not pinned/);
  await assert.rejects(fakeSelf.fetch('https://cdn.example/deu.traineddata'), /not pinned/);
  await fakeSelf.fetch('https://cdn.example/other.json', { method: 'GET' });
  assert.deepEqual(seen[1], ['https://cdn.example/other.json', { method: 'GET' }]);
  // Real pins are sha384 SRI strings on exact versions.
  for (const [url, sri] of Object.entries(_ocrInternals.TESSERACT_LANG_FILES)) {
    assert.match(url, /@\d+\.\d+\.\d+\//);
    assert.match(sri, /^sha384-[A-Za-z0-9+/]{64}$/);
  }
  assert.match(_ocrInternals.TESSERACT_CORE.integrity, /^sha384-[A-Za-z0-9+/]{64}$/);
});
