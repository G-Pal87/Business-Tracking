// Minimal browser-ish globals so app modules can be imported under node:test.
function memStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    key: i => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    clear: () => m.clear(),
  };
}
globalThis.localStorage = memStorage();
globalThis.sessionStorage = memStorage();
globalThis.window = globalThis;
globalThis.document = globalThis.document || {
  addEventListener() {}, getElementById() { return null }, querySelector() { return null },
  createElement() { return { style: {}, appendChild() {}, addEventListener() {}, classList: { add() {}, remove() {} } }; },
  body: { appendChild() {}, classList: { add() {}, remove() {} } },
};
globalThis.addEventListener = globalThis.addEventListener || (() => {});
