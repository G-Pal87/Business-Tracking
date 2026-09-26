// Cache-busting version for the app's ES modules. The Pages deploy workflow
// stamps js/version.js with the commit SHA, so a deploy busts every module
// URL once and repeat visits reuse the browser cache. Unstamped ("dev", local
// server) or unreadable → a fresh Date.now() per load, i.e. always refetch.
let _v = '';
let dev = false; // version.js read fine and says "dev": imports carry no ?v
try {
  // Unique URL each load, so this tiny file is never served from cache.
  const { v } = await import(new URL(`./version.js?t=${Date.now()}`, import.meta.url));
  if (typeof v === 'string' && v && v !== 'dev') _v = encodeURIComponent(v.trim());
  else if (v === 'dev') dev = true;
} catch { /* offline / missing file — fall back below */ }
const stamped = !!_v;
if (!_v) _v = String(Date.now());
window._appV = _v;

// Preload the core modules app.js imports statically, in parallel with
// app.js itself, instead of discovering them one level at a time. Each URL
// must be exactly what the module graph requests, or the preload is simply a
// wasted fetch: the Pages workflow stamps every static relative import with
// ?v=<sha12> — the same value version.js carries (_v) — and in an unstamped
// ("dev") checkout they carry no query at all. When version.js couldn't be
// read, the right URLs are unknown, so only app.js is preloaded.
// Keep in step with the static imports of js/app.js and of the core files
// it pulls in (state, data, config, ui, dates, github, crypto, router,
// charts, auth, presence).
const CORE = ['state', 'data', 'config', 'ui', 'dates', 'github', 'crypto', 'router', 'charts', 'libs', 'auth', 'presence'];
const preload = rel => {
  try {
    const link = document.createElement('link');
    link.rel = 'modulepreload';
    link.href = new URL(rel, import.meta.url).href;
    document.head.appendChild(link);
  } catch { /* preloading is only an optimization */ }
};
preload(`./app.js?v=${_v}`);
if (stamped || dev) {
  const q = stamped ? `?v=${_v}` : '';
  for (const name of CORE) preload(`./core/${name}.js${q}`);
}
import(`./app.js?v=${_v}`);
