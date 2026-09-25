// On-demand loading of heavy third-party libraries that only a few actions
// need (PDF text extraction, OCR, ZIP downloads). They used to be loaded as
// render-blocking <script> tags on every page load. Same pinned versions and
// SRI hashes as before; the CSP already allows cdn.jsdelivr.net scripts.
const LIBS = {
  pdfjs: {
    global: 'pdfjsLib',
    src: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
    integrity: 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e'
  },
  tesseract: {
    global: 'Tesseract',
    src: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
    integrity: 'sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F'
  },
  jszip: {
    global: 'JSZip',
    src: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
    integrity: 'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG'
  }
};

const _loading = new Map();

// Resolves to the library's global once loaded; rejects with a readable error.
export function loadLib(name) {
  const lib = LIBS[name];
  if (!lib) return Promise.reject(new Error(`Unknown library: ${name}`));
  if (window[lib.global]) return Promise.resolve(window[lib.global]);
  if (_loading.has(name)) return _loading.get(name);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = lib.src;
    s.integrity = lib.integrity;
    s.crossOrigin = 'anonymous';
    s.onload = () => window[lib.global]
      ? resolve(window[lib.global])
      : reject(new Error(`${name} loaded but is unavailable`));
    s.onerror = () => { _loading.delete(name); s.remove(); reject(new Error(`Could not load ${name} — check your connection and try again`)); };
    document.head.appendChild(s);
  });
  _loading.set(name, p);
  return p;
}
