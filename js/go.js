// One-tap message links from the electricity calendar reminders:
//   <app>/#go=<base64url JSON {c, n, e, s, t, p}>
// c = channel ('w' WhatsApp, 'v' Viber, 'e' email), n = phone digits,
// e = email, s = email subject, t = message text, p = property id.
// Runs before the app loads and hands over to WhatsApp (chat + text) or the
// mail app straight away. Viber can't open a chat with the text filled in, so
// for Viber this shows one button that copies the message and opens the
// tenant's chat (phones only allow copying after a tap) — paste and send.
// Each hand-over notes "message sent for property p today" in this browser;
// the app applies it to the reading cycle next time it opens here.
// Only these targets are ever built — never an arbitrary URL from the link —
// so it can't be used as an open redirect. Nothing is sent to any server: the
// payload is in the URL fragment.
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
  else if (d && d.c === 'v') target = digits ? 'viber://chat?number=%2B' + digits : 'viber://forward?text=' + encodeURIComponent(text);
  else if (d && d.c === 'e' && /^[^\s@<>"]+@[^\s@<>"]+$/.test(String(d.e || ''))) {
    target = 'mailto:' + encodeURIComponent(d.e).replace(/%40/g, '@') + '?subject=' + encodeURIComponent(String(d.s || 'Electricity meter reading').slice(0, 120)) + '&body=' + encodeURIComponent(text);
  }
  if (!target) return; // malformed: just open the app
  var viberChat = d.c === 'v' && !!digits;

  var noteSent = function () {
    if (!d.p || !/^[\w-]{1,64}$/.test(d.p)) return;
    try {
      var k = 'bt_elec_sent';
      var q = JSON.parse(localStorage.getItem(k) || '[]');
      if (!Array.isArray(q)) q = [];
      var now = new Date();
      var at = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2) + '-' + ('0' + now.getDate()).slice(-2);
      q.push({ p: d.p, at: at, c: d.c });
      localStorage.setItem(k, JSON.stringify(q.slice(-200)));
    } catch (e) { /* storage blocked: the send still works */ }
  };
  var legacyCopy = function (s) {
    var ta = document.createElement('textarea');
    ta.value = s; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:-1000px';
    document.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  };
  var copy = function (s) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(s).then(function () { return true; }, function () { return legacyCopy(s); });
      }
    } catch (e) { /* fall through */ }
    return Promise.resolve(legacyCopy(s));
  };

  // Don't boot the app for this.
  try { window.stop(); } catch (e) { /* ignore */ }
  var shown = false;
  var show = function () {
    if (shown) return;
    shown = true;
    var body = document.body || document.documentElement.appendChild(document.createElement('body'));
    body.textContent = '';
    body.style.cssText = 'font-family:system-ui,sans-serif;padding:24px;max-width:520px;margin:auto;background:#111;color:#eee';
    var name = d.c === 'w' ? 'WhatsApp' : d.c === 'v' ? 'Viber' : 'your mail app';
    var p = document.createElement('p');
    var btn = document.createElement('a');
    btn.href = target;
    btn.style.cssText = 'display:inline-block;padding:12px 18px;border-radius:8px;background:#7360f2;color:#fff;text-decoration:none;font-size:16px';
    var status = document.createElement('p');
    status.style.cssText = 'color:#9ca3af;font-size:14px';
    if (viberChat) {
      p.textContent = 'Viber can\'t fill in the message for you: tap the button, then paste the message in the chat and send.';
      btn.textContent = 'Copy message & open Viber chat';
      btn.onclick = function (e) {
        e.preventDefault();
        copy(text).then(function (ok) {
          status.textContent = ok ? 'Message copied — paste it in the chat.' : 'Could not copy — select the message below and copy it.';
          noteSent();
          window.location.href = target;
        });
      };
    } else {
      p.textContent = 'Opening ' + name + '… If nothing happens, tap the button.';
      btn.textContent = 'Open ' + (d.c === 'e' ? 'email' : name);
    }
    var pre = document.createElement('p');
    pre.textContent = text;
    pre.style.cssText = 'margin-top:16px;padding:10px;border:1px solid #444;border-radius:6px;white-space:pre-wrap;user-select:all';
    body.appendChild(p); body.appendChild(btn); body.appendChild(status); body.appendChild(pre);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
  setTimeout(show, 50);
  if (!viberChat) { noteSent(); window.location.replace(target); }
})();
