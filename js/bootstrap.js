const _v = Date.now();
window._appV = _v;
import(`./app.js?v=${_v}`);
