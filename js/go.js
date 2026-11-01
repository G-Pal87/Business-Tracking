// One-tap message links from the electricity calendar reminders:
//   <app>/#go=<base64url JSON {c, n, e, t, p}>
// c = channel ('w' WhatsApp, 'v' Viber, 'e' email), n = phone digits,
// e = email, s = email subject, t = message text, p = property id.
// Runs before the app loads: notes "message sent for property p today" in
// this browser (the app applies it to the reading cycle next time it opens
// here), then hands over to WhatsApp / Viber / the mail app. Only these three
// targets are ever built — never an arbitrary URL from the link — so it can't
// be used as an open redirect. Nothing is sent to any server: the payload is in
// the URL fragment.
(function () {
  var h = window.location.hash;
  if (h.indexOf('#go=') !== 0) return;
  var d;
  try {
    var b = h.slice(4).replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    d = JSON.parse(decodeURIComponent(escape(atob(b))));
  } catch (e) { d = null; }
  var digits = d && String(d.n || '').replace(/\D/g, '');
  var text = d && String(d.t || '').slice(0, 2000);
  var target = null;
  if (d && d.c === 'w' && digits) target = 'https://wa.me/' + digits + '?text=' + encodeURIComponent(text);
  else if (d && d.c === 'v') target = 'viber://forward?text=' + encodeURIComponent(text);
  else if (d && d.c === 'e' && /^[^\s@<>"]+@[^\s@<>"]+$/.test(String(d.e || ''))) {
    target = 'mailto:' + encodeURIComponent(d.e).replace(/%40/g, '@') + '?subject=' + encodeURIComponent(String(d.s || 'Electricity meter reading').slice(0, 120)) + '&body=' + encodeURIComponent(text);
  }
  if (!target) return; // malformed: just open the app
  if (d.p && /^[\w-]{1,64}$/.test(d.p)) {
    try {
      var k = 'bt_elec_sent';
      var q = JSON.parse(localStorage.getItem(k) || '[]');
      if (!Array.isArray(q)) q = [];
      var now = new Date();
      var at = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2) + '-' + ('0' + now.getDate()).slice(-2);
      q.push({ p: d.p, at: at, c: d.c });
      localStorage.setItem(k, JSON.stringify(q.slice(-200)));
    } catch (e) { /* storage blocked: the send still works */ }
  }
  // Don't boot the app for this; show a fallback in case the hand-over is blocked.
  try { window.stop(); } catch (e) { /* ignore */ }
  var show = function () {
    var body = document.body || document.documentElement.appendChild(document.createElement('body'));
    body.textContent = '';
    body.style.cssText = 'font-family:system-ui,sans-serif;padding:24px;max-width:520px;margin:auto;background:#111;color:#eee';
    var p = document.createElement('p');
    p.textContent = 'Opening ' + (d.c === 'w' ? 'WhatsApp' : d.c === 'v' ? 'Viber' : 'your mail app') + '… If nothing happens, tap the button.';
    var a = document.createElement('a');
    a.href = target;
    a.textContent = 'Open ' + (d.c === 'w' ? 'WhatsApp' : d.c === 'v' ? 'Viber' : 'email');
    a.style.cssText = 'display:inline-block;padding:10px 16px;border-radius:8px;background:#6366f1;color:#fff;text-decoration:none';
    var pre = document.createElement('p');
    pre.textContent = text;
    pre.style.cssText = 'margin-top:16px;padding:10px;border:1px solid #444;border-radius:6px;white-space:pre-wrap;user-select:all';
    body.appendChild(p); body.appendChild(a); body.appendChild(pre);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
  setTimeout(show, 50);
  window.location.replace(target);
})();
