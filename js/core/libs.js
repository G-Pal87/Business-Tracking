// On-demand loading of heavy third-party libraries that only a few actions
// need (charts, PDF generation and text extraction, OCR, ZIP downloads). They used to be loaded as
// render-blocking <script> tags on every page load. Every file is pinned to an
// exact version. The CSP in index.html lists each of these URLs exactly —
// changing a version here means updating script-src/worker-src there too.
//
// Integrity: the main scripts load with SRI. Web workers can't take an
// `integrity` attribute, so their scripts are fetched here with fetch()'s own
// `integrity` option (the browser rejects a mismatching response), then started
// from a blob: URL (CSP worker-src allows blob:). Only the Tesseract core
// (importScripts'ed inside its worker) and its language data (fetched by the
// worker) can't be integrity-checked; both are pinned to exact versions.
const LIBS = {
  // Charts (core/charts.js starts this download at import and queues chart
  // creation until it's in). chart.js has no pre-built .min.js in the npm
  // package, so jsdelivr would minify it on the fly — bytes that can't be
  // pinned with a reproducible SRI hash; the unminified UMD build ships as-is.
  chart: {
    global: 'Chart',
    src: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js',
    integrity: 'sha384-dug+JxfBvklEQdJ4AYuBBAIScUz0bVN73xpy273gcAwHjb3qI0fXmuYNaNfdyYJG'
  },
  pdfjs: {
    global: 'pdfjsLib',
    src: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
    integrity: 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e',
    setup: setupPdfjs
  },
  tesseract: {
    global: 'Tesseract',
    src: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
    integrity: 'sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F',
    setup: setupTesseract
  },
  // Invoice PDF generation (core/pdf.js) — the UMD build exposes window.jspdf.
  jspdf: {
    global: 'jspdf',
    src: 'https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js',
    integrity: 'sha384-qovJwSBbRDPP5cEjCp8S0UP66wrvnjaa60XMOGzTNanrThcrGfXfnZkvgY8N1KT3'
  },
  jszip: {
    global: 'JSZip',
    src: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
    integrity: 'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG'
  }
};

const PDFJS_WORKER = {
  src: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
  integrity: 'sha384-SnzOobpRMLXZ52iJvZm/C0fYw0OQemTXzTjIsdsfMcrCtCEe9qgzxTd3RSklO5x2'
};
const TESSERACT_WORKER = {
  src: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
  integrity: 'sha384-zxn+VqofFzXpH99dUb3fa4ywoSBQJPy6/6oEaJHPlblZXr53a0g1Jl6720vgSzB7'
};
// Exact versions (tesseract.js 5.1.1 depends on tesseract.js-core ^5.1.1).
const TESSERACT_CORE = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-simd-lstm.wasm.js';
const TESSERACT_LANG = 'https://tessdata.projectnaptha.com/4.0.0';

const _blobUrls = new Map();

// Fetches a script with an integrity check and returns a blob: URL for it.
function verifiedScriptUrl({ src, integrity }) {
  if (_blobUrls.has(src)) return _blobUrls.get(src);
  const p = fetch(src, { integrity, credentials: 'omit', cache: 'force-cache' })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.blob();
    })
    .then(blob => URL.createObjectURL(new Blob([blob], { type: 'text/javascript' })))
    .catch(err => {
      _blobUrls.delete(src);
      throw new Error(`Could not load a verified copy of ${src.split('/npm/')[1] || src} (${err.message})`);
    });
  _blobUrls.set(src, p);
  return p;
}

// pdf.js uses GlobalWorkerOptions.workerPort, when set, instead of workerSrc,
// so the worker is always the integrity-checked copy (a workerSrc set later by
// a caller is ignored).
async function setupPdfjs(lib) {
  if (lib.GlobalWorkerOptions.workerPort) return;
  const url = await verifiedScriptUrl(PDFJS_WORKER);
  lib.GlobalWorkerOptions.workerPort = new Worker(url);
}

// Every OCR worker gets the pinned, integrity-checked worker script and the
// pinned core/language data, whatever paths the caller passes.
async function setupTesseract(T) {
  if (T.__btPinned) return;
  const createWorker = T.createWorker;
  T.createWorker = async (langs, oem, options = {}, config) => {
    const workerPath = await verifiedScriptUrl(TESSERACT_WORKER);
    return createWorker(langs, oem, {
      ...options,
      workerPath,
      workerBlobURL: false, // start the verified blob directly (no importScripts wrapper)
      corePath: TESSERACT_CORE,
      langPath: TESSERACT_LANG
    }, config);
  };
  T.__btPinned = true;
}

const _loading = new Map();

// Resolves to the library's global once loaded; rejects with a readable error.
export function loadLib(name) {
  const lib = LIBS[name];
  if (!lib) return Promise.reject(new Error(`Unknown library: ${name}`));
  if (_loading.has(name)) return _loading.get(name);
  const p = new Promise((resolve, reject) => {
    if (window[lib.global]) { resolve(window[lib.global]); return; }
    const s = document.createElement('script');
    s.src = lib.src;
    s.integrity = lib.integrity;
    s.crossOrigin = 'anonymous';
    s.onload = () => window[lib.global]
      ? resolve(window[lib.global])
      : reject(new Error(`${name} loaded but is unavailable`));
    s.onerror = () => { s.remove(); reject(new Error(`Could not load ${name} — check your connection and try again`)); };
    document.head.appendChild(s);
  })
    .then(async g => { if (lib.setup) await lib.setup(g); return g; })
    .catch(err => { _loading.delete(name); throw err; });
  _loading.set(name, p);
  return p;
}
