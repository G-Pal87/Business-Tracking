// On-demand loading of heavy third-party libraries that only a few actions
// need (charts, PDF generation and text extraction, OCR, ZIP downloads). They used to be loaded as
// render-blocking <script> tags on every page load. Every file is pinned to an
// exact version. The CSP in index.html lists each of these URLs exactly —
// changing a version here means updating script-src/worker-src there too.
//
// Integrity: the main scripts load with SRI. Web workers can't take an
// `integrity` attribute, so their scripts are fetched here with fetch()'s own
// `integrity` option (the browser rejects a mismatching response), then started
// from a blob: URL (CSP worker-src allows blob:). The OCR worker goes one step
// further: the Tesseract core and the worker script are both fetched with
// integrity checks and joined into one blob (so the worker never
// importScripts anything), and its language-data download is integrity-checked
// too (see buildOcrWorkerUrl).
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
// The .wasm.js build embeds the WebAssembly binary, so this one file is the
// whole core. Hash = sha384 of the file in the npm package
// (npm pack tesseract.js-core@5.1.1), which jsdelivr serves byte-for-byte.
const TESSERACT_CORE = {
  src: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-simd-lstm.wasm.js',
  integrity: 'sha384-YM1G+zaWYy9VSRP2C101LCgzh7n3Hqb6OEm9qDoZYgCADsni3nnECskC3WialQB7'
};
// Language data: the standard tessdata 4.0.0 English model (the same model
// set the app used from tessdata.projectnaptha.com/4.0.0), from the pinned
// npm package @tesseract.js-data/eng@1.0.0, file 4.0.0/eng.traineddata.gz.
// The worker requests `${TESSERACT_LANG}/eng.traineddata.gz`.
const TESSERACT_LANG = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0';
const TESSERACT_LANG_FILES = {
  [`${TESSERACT_LANG}/eng.traineddata.gz`]: 'sha384-bU4PcJLjEjKdIn7s09uKX4NpMPH2ZyApTe8VWX+c5jNGCk3bumt+lhZtlOA7ujK1'
};

const _blobUrls = new Map();

// Fetches a file with an integrity check; resolves to its text.
async function verifiedText({ src, integrity }) {
  try {
    const res = await fetch(src, { integrity, credentials: 'omit', cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    throw new Error(`Could not load a verified copy of ${src.split('/npm/')[1] || src} (${err.message})`);
  }
}

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

// Runs inside the OCR worker before tesseract's own code: language data may
// only come from the pinned URLs, fetched with their integrity hashes (the
// browser rejects a mismatching response); any other .traineddata request is
// refused. Other requests pass through unchanged.
function ocrFetchGuard(files) {
  return `;(function () {
  var pinned = ${JSON.stringify(files)};
  var origFetch = self.fetch.bind(self);
  self.fetch = function (input, init) {
    var url = String(input && input.url ? input.url : input);
    if (Object.prototype.hasOwnProperty.call(pinned, url)) {
      return origFetch(url, { integrity: pinned[url], credentials: 'omit', cache: 'force-cache' });
    }
    if (/\\.traineddata(\\.gz)?(\\?|#|$)/.test(url)) {
      return Promise.reject(new Error('Language data not pinned: ' + url));
    }
    return origFetch(input, init);
  };
})();
`;
}

// One blob: integrity-checked core (defines TesseractCore, so tesseract's
// getCore never importScripts a core URL), then the fetch guard, then the
// integrity-checked worker script.
let _ocrWorkerUrl = null;
function buildOcrWorkerUrl() {
  if (_ocrWorkerUrl) return _ocrWorkerUrl;
  _ocrWorkerUrl = Promise.all([verifiedText(TESSERACT_CORE), verifiedText(TESSERACT_WORKER)])
    .then(([core, worker]) => URL.createObjectURL(new Blob(
      [core, '\n;\n', ocrFetchGuard(TESSERACT_LANG_FILES), '\n;\n', worker],
      { type: 'text/javascript' })))
    .catch(err => { _ocrWorkerUrl = null; throw err; });
  return _ocrWorkerUrl;
}

// Every OCR worker gets the pinned, integrity-checked worker script, core and
// language data, whatever paths the caller passes. cacheMethod 'none': the
// worker would otherwise read language data from its own IndexedDB cache,
// which isn't integrity-checked (the browser's HTTP cache, used instead via
// force-cache, is re-verified on every load).
async function setupTesseract(T) {
  if (T.__btPinned) return;
  const createWorker = T.createWorker;
  T.createWorker = async (langs, oem, options = {}, config) => {
    const workerPath = await buildOcrWorkerUrl();
    // tesseract.js 5.1.1's createWorker never settles when loading the
    // language data fails (a network error, or the integrity check above
    // rejecting it) — it only throws inside its message handler. An
    // errorHandler turns that into a rejection here instead of a hung OCR.
    let fail;
    const failed = new Promise((_, reject) => { fail = reject; });
    failed.catch(() => {});
    const userErrorHandler = options.errorHandler;
    const ready = createWorker(langs, oem, {
      ...options,
      workerPath,
      workerBlobURL: false, // start the verified blob directly (no importScripts wrapper)
      corePath: TESSERACT_CORE.src, // never loaded: the blob already defines TesseractCore
      langPath: TESSERACT_LANG,
      cacheMethod: 'none',
      gzip: true,
      errorHandler: err => {
        try { userErrorHandler?.(err); } catch { /* caller's handler */ }
        fail(new Error(`OCR could not start: ${err}`));
      }
    }, config);
    return Promise.race([ready, failed]);
  };
  T.__btPinned = true;
}

// Exposed for tests only.
export const _ocrInternals = { ocrFetchGuard, TESSERACT_LANG_FILES, TESSERACT_CORE };

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
