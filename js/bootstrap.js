// Cache-busting version for the app's ES modules. The Pages deploy workflow
// stamps js/version.js with the commit SHA, so a deploy busts every module
// URL once and repeat visits reuse the browser cache. Unstamped ("dev", local
// server) or unreadable → a fresh Date.now() per load, i.e. always refetch.
let _v = '';
try {
  // Unique URL each load, so this tiny file is never served from cache.
  const { v } = await import(new URL(`./version.js?t=${Date.now()}`, import.meta.url));
  if (typeof v === 'string' && v && v !== 'dev') _v = encodeURIComponent(v.trim());
} catch { /* offline / missing file — fall back below */ }
if (!_v) _v = String(Date.now());
window._appV = _v;
import(`./app.js?v=${_v}`);
