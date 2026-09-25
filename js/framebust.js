// Refuse to run inside a frame (clickjacking). A meta-tag CSP can't set
// frame-ancestors and GitHub Pages can't send headers, so this is the only
// guard available. Loaded as a classic, blocking script at the top of <head>
// so it runs before anything renders or the app's modules start.
(function () {
  var framed;
  try { framed = window.top !== window.self; } catch (e) { framed = true; }
  if (!framed) return;
  document.documentElement.style.display = 'none';
  try { window.top.location.href = window.self.location.href; } catch (e) { /* sandboxed or cross-origin: stay hidden */ }
  // Stop parsing so the app's scripts never load in the frame.
  try { window.stop(); } catch (e) { /* older browsers: the page stays hidden */ }
})();
