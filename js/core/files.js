// Opening stored files (documents, receipts) safely.
//
// A blob: URL has the app's own origin. If a stored file were opened under
// whatever MIME type its synced record claims (text/html, image/svg+xml, …),
// it would run as a page on this origin, able to read the GitHub token and
// the local cache. So the type is never taken from the record: the first
// bytes decide, only a short allow-list of types that can't run script is
// previewed, and everything else is downloaded as application/octet-stream.

// PDF readers accept the header anywhere in the first 1 KB.
const PDF_SCAN_BYTES = 1024;

function startsWith(b, sig, offset = 0) {
  if (b.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[offset + i] !== sig[i]) return false;
  return true;
}

// Returns the preview MIME type for these bytes, or null when the file isn't
// one of PDF, PNG, JPEG, GIF or WebP.
export function sniffPreviewMime(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  if (startsWith(b, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'image/png';
  if (startsWith(b, [0xFF, 0xD8, 0xFF])) return 'image/jpeg';
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38]) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif';
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  const pdfSig = [0x25, 0x50, 0x44, 0x46, 0x2D]; // "%PDF-"
  const end = Math.min(b.length - pdfSig.length, PDF_SCAN_BYTES);
  for (let i = 0; i <= end; i++) if (b[i] === 0x25 && startsWith(b, pdfSig, i)) return 'application/pdf';
  return null;
}

// A file name that is safe to hand to <a download>: no path separators,
// control characters or leading dots, and a bounded length that keeps the
// extension.
export function safeDownloadName(name, fallback = 'file') {
  let n = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/^[.\s]+/, '')
    .trim();
  if (n.length > 150) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 10 ? n.slice(dot) : '';
    n = n.slice(0, 150 - ext.length) + ext;
  }
  return n || fallback;
}

export function base64ToBytes(b64) {
  const bin = atob(String(b64 || '').replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function downloadBytes(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = safeDownloadName(name);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Previews an allow-listed file in a new tab, or downloads it otherwise.
// Returns 'preview' or 'download'.
export function openFileSafely(bytes, name) {
  const mime = sniffPreviewMime(bytes);
  if (!mime) { downloadBytes(bytes, name); return 'download'; }
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  // noopener: the new tab gets no handle back to this window. window.open
  // then always returns null, so there is no load event to revoke on; the
  // URL is revoked after the tab has had ample time to load it.
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  return 'preview';
}

// ── Preparing files for upload ───────────────────────────────────────────────
// Uploads go through GitHub's Contents API, which rejects files over 100 MB
// and needs the whole file base64-encoded in one request (held in browser
// memory several times over), and stored files are encrypted, so GitHub can't
// compress or delta them — every byte counts in full, forever in history.
// So: a hard per-file limit, and phone photos are shrunk before upload.

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const RESIZE_MAX_PX = 2000;  // longest side; plenty for reading a document photo
const JPEG_QUALITY = 0.85;
// Photos smaller than this are uploaded as-is (minus their metadata, below):
// decoding and re-encoding them costs time and rarely saves anything.
const RESIZE_MIN_BYTES = 300 * 1024;
// GIFs may be animated and SVGs aren't raster — both are uploaded as-is.
const RESIZABLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function fmtFileSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// ── Storage-path extensions ──────────────────────────────────────────────────
// Stored files live at public repo paths (the bytes are encrypted, the path is
// not), so nothing from the user's file name may reach the path except a
// short, plain extension. "scan of passport" or "lease.john smith" must not
// leak text into the path.
const MIME_EXT = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv',
  'text/plain': 'txt'
};

// The extension (without the dot, lowercased) to use in a storage path for a
// file named `name` with MIME type `mime`: the name's own extension only when
// it is 1–5 plain letters/digits, else one derived from the MIME type, else ''.
export function safeStorageExt(name, mime) {
  const base = String(name ?? '').split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  if (dot > 0 || (dot === 0 && base.length > 1)) {
    const ext = base.slice(dot + 1).toLowerCase();
    if (/^[a-z0-9]{1,5}$/.test(ext)) return ext;
  }
  return MIME_EXT[String(mime ?? '').toLowerCase().split(';')[0].trim()] || '';
}

// `${stem}.${ext}` or just `stem` when no safe extension can be derived.
export function storagePathWithExt(stem, name, mime) {
  const ext = safeStorageExt(name, mime);
  return ext ? `${stem}.${ext}` : stem;
}

// ── Photo metadata ───────────────────────────────────────────────────────────
// Phone photos carry EXIF (GPS position, device, time) and often XMP/IPTC.
// The stored bytes are encrypted, but anyone who can open a document would
// still see where it was taken, so metadata is removed before upload:
//   - JPEG: re-encoded photos have none (canvas output carries no metadata);
//     an original kept as-is has its APP1 (EXIF/XMP), APP13 (IPTC) and COM
//     segments removed losslessly. Only the EXIF orientation survives, as a
//     minimal one-tag EXIF block, so the photo isn't shown rotated.
//   - PNG: the eXIf chunk is removed losslessly (text chunks are kept).
//   - WebP, GIF, HEIC and everything else kept as-is are NOT rewritten: a
//     WebP that re-encoding couldn't shrink keeps any EXIF/XMP chunk, and
//     HEIC can't be decoded in most browsers. Both are rare for uploads here.

function readU16(b, o, le) { return le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]; }
function readU32(b, o, le) {
  return le
    ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
    : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

// EXIF orientation (1–8) from an APP1 payload (the bytes after the length
// field), or 0 when there is none.
function exifOrientation(seg) {
  if (seg.length < 14 || !startsWith(seg, [0x45, 0x78, 0x69, 0x66, 0, 0])) return 0; // "Exif\0\0"
  const t = seg.subarray(6);
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4D && t[1] === 0x4D)) return 0;
  if (readU16(t, 2, le) !== 42) return 0;
  const ifd = readU32(t, 4, le);
  if (ifd + 2 > t.length) return 0;
  const n = readU16(t, ifd, le);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) return 0;
    if (readU16(t, e, le) === 0x0112) {
      const v = readU16(t, e + 8, le);
      return v >= 1 && v <= 8 ? v : 0;
    }
  }
  return 0;
}

// A complete APP1 segment holding only an EXIF orientation tag.
function orientationApp1(orientation) {
  const payload = [
    0x45, 0x78, 0x69, 0x66, 0, 0,          // "Exif\0\0"
    0x4D, 0x4D, 0, 42, 0, 0, 0, 8,         // big-endian TIFF header, IFD0 at 8
    0, 1,                                  // one entry
    0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, // Orientation, SHORT, 1
    0, 0, 0, 0                             // no next IFD
  ];
  const len = payload.length + 2;
  return new Uint8Array([0xFF, 0xE1, len >> 8, len & 0xFF, ...payload]);
}

// Parses a JPEG's header segments. Returns { segs: [{marker, start, end}],
// scan } (scan = offset of the SOS marker) or null when malformed.
function jpegSegments(b) {
  if (!startsWith(b, [0xFF, 0xD8])) return null;
  const segs = [];
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xFF) return null;
    let m = b[o + 1];
    if (m === 0xFF) { o++; continue; } // fill byte
    if (m === 0xDA) return { segs, scan: o };
    if (m === 0xD8 || m === 0xD9 || (m >= 0xD0 && m <= 0xD7) || m === 0x01) { segs.push({ marker: m, start: o, end: o + 2 }); o += 2; continue; }
    const len = (b[o + 2] << 8) | b[o + 3];
    if (len < 2 || o + 2 + len > b.length) return null;
    segs.push({ marker: m, start: o, end: o + 2 + len });
    o += 2 + len;
  }
  return null;
}

// Returns the JPEG without EXIF/XMP (APP1), IPTC (APP13) and comment
// segments, keeping only the orientation (see above); the same array when
// there was nothing to remove; null when the bytes aren't a parsable JPEG.
export function stripJpegMetadata(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  const parsed = jpegSegments(b);
  if (!parsed) return null;
  let orientation = 0, removed = false;
  const keep = [];
  for (const s of parsed.segs) {
    if (s.marker === 0xE1 || s.marker === 0xED || s.marker === 0xFE) {
      if (s.marker === 0xE1 && !orientation) orientation = exifOrientation(b.subarray(s.start + 4, s.end));
      removed = true;
      continue;
    }
    keep.push(s);
  }
  if (!removed) return b;
  const app1 = orientation > 1 ? orientationApp1(orientation) : null;
  // The orientation block goes right after SOI, or after a leading JFIF APP0.
  const parts = [b.subarray(0, 2)];
  let first = true;
  for (const s of keep) {
    if (app1 && first && s.marker !== 0xE0) { parts.push(app1); first = false; }
    parts.push(b.subarray(s.start, s.end));
    if (app1 && first && s.marker === 0xE0) { parts.push(app1); first = false; }
  }
  if (app1 && first) parts.push(app1);
  parts.push(b.subarray(parsed.scan));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Returns the PNG without its eXIf chunk; the same array when it has none;
// null when the bytes aren't a parsable PNG.
export function stripPngMetadata(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  if (!startsWith(b, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return null;
  const parts = [b.subarray(0, 8)];
  let o = 8, removed = false;
  while (o + 12 <= b.length) {
    const len = readU32(b, o, false);
    const end = o + 12 + len;
    if (end > b.length) return null;
    const isExif = b[o + 4] === 0x65 && b[o + 5] === 0x58 && b[o + 6] === 0x49 && b[o + 7] === 0x66; // eXIf
    if (isExif) {
      // Browsers apply a PNG eXIf orientation: dropping a rotated one would
      // show the image sideways. Keep such a file as it is.
      const tiff = b.subarray(o + 8, o + 8 + len);
      const withHeader = new Uint8Array(6 + tiff.length);
      withHeader.set([0x45, 0x78, 0x69, 0x66, 0, 0]); withHeader.set(tiff, 6);
      if (exifOrientation(withHeader) > 1) return b;
      removed = true;
    } else parts.push(b.subarray(o, end));
    o = end;
  }
  if (o !== b.length) return null;
  if (!removed) return b;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

// Pixel size as displayed ({ width, height }, EXIF orientation applied for
// JPEG), read from the header without decoding; null when unknown.
export function imageDisplaySize(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  if (startsWith(b, [0x89, 0x50, 0x4E, 0x47]) && b.length >= 24) {
    return { width: readU32(b, 16, false), height: readU32(b, 20, false) };
  }
  const parsed = jpegSegments(b);
  if (!parsed) return null;
  let orientation = 1, size = null;
  for (const s of parsed.segs) {
    const m = s.marker;
    if (m === 0xE1 && orientation === 1) orientation = exifOrientation(b.subarray(s.start + 4, s.end)) || 1;
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC && s.end - s.start >= 9) {
      size = { height: readU16(b, s.start + 5, false), width: readU16(b, s.start + 7, false) };
    }
  }
  if (!size || !size.width || !size.height) return null;
  return orientation >= 5 ? { width: size.height, height: size.width } : size;
}

// Decodes the image to a bitmap no larger than RESIZE_MAX_PX on its longest
// side. Where the browser supports createImageBitmap's resize options, the
// image is decoded straight to the reduced size (a 48 MP photo never needs a
// full-size bitmap); otherwise — or if the result doesn't have the expected
// shape — it falls back to a full decode, scaled when drawn.
async function decodeScaled(file, bytes) {
  const dims = imageDisplaySize(bytes);
  if (dims) {
    const scale = Math.min(1, RESIZE_MAX_PX / Math.max(dims.width, dims.height));
    if (scale < 1) {
      const w = Math.max(1, Math.round(dims.width * scale));
      const h = Math.max(1, Math.round(dims.height * scale));
      let bmp = null;
      try {
        bmp = await createImageBitmap(file, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
        const sameShape = Math.abs(bmp.width / bmp.height - dims.width / dims.height) < 0.02;
        if (sameShape) { const out = bmp; bmp = null; return out; }
      } catch { /* resize options unsupported — full decode below */ }
      finally { bmp?.close?.(); }
    }
  }
  return createImageBitmap(file); // applies EXIF orientation
}

async function reencodeJpeg(file, bytes) {
  let bmp = null;
  try {
    bmp = await decodeScaled(file, bytes);
    const scale = Math.min(1, RESIZE_MAX_PX / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // JPEG has no transparency — PNG see-through areas become white, not black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    bmp = null;
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
    canvas.width = canvas.height = 0; // release the backing store now
    return blob;
  } finally {
    bmp?.close?.();
  }
}

function isJpegFile(file, bytes) {
  return file.type === 'image/jpeg' || sniffPreviewMime(bytes.subarray(0, 16)) === 'image/jpeg';
}

// Resolves to { file, resized } ready to upload — a re-encoded JPEG (name
// ending .jpg, resized: true) when a photo could be made smaller, else the
// original with its metadata removed (see "Photo metadata" above) — or
// { error } when the file is over the limit. Never throws: if the browser
// can't decode the image, the original is used (still metadata-stripped when
// it's a parsable JPEG/PNG).
export async function prepareUploadFile(file) {
  if (file.size > MAX_UPLOAD_BYTES) {
    return { error: `${file.name} is ${fmtFileSize(file.size)} — the limit is ${fmtFileSize(MAX_UPLOAD_BYTES)} per file. Compress or split it first.` };
  }
  const maybeImage = RESIZABLE_TYPES.has(file.type) || /^image\//.test(file.type || '') || !file.type;
  if (!maybeImage || typeof file.arrayBuffer !== 'function') return { file, resized: false };
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); } catch { return { file, resized: false }; }
  const jpeg = isJpegFile(file, bytes);
  const png = !jpeg && startsWith(bytes, [0x89, 0x50, 0x4E, 0x47]);

  let stripped = jpeg ? stripJpegMetadata(bytes) : png ? stripPngMetadata(bytes) : bytes;
  const keptSize = stripped ? stripped.length : file.size;

  let blob = null;
  const canResize = RESIZABLE_TYPES.has(file.type) && typeof createImageBitmap === 'function' && typeof document !== 'undefined';
  if (canResize && (file.size >= RESIZE_MIN_BYTES || (jpeg && !stripped))) {
    try { blob = await reencodeJpeg(file, bytes); } catch { blob = null; }
  }
  // Re-encoded output wins when it's smaller — or when the original is a JPEG
  // whose metadata couldn't be removed losslessly (canvas output has none).
  if (blob && (blob.size < keptSize || (jpeg && !stripped))) {
    const name = file.name.replace(/\.[^./]+$/, '') + '.jpg';
    return { file: new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified }), resized: true };
  }
  if (stripped && stripped !== bytes) {
    return { file: new File([stripped], file.name, { type: file.type, lastModified: file.lastModified }), resized: false };
  }
  return { file, resized: false };
}

// prepareUploadFile over several files, with one summary toast-ready message
// for what was shrunk and one per rejected file. `notify(msg, kind)` shows them.
export async function prepareUploadFiles(files, notify) {
  const ready = [];
  let before = 0, after = 0, shrunk = 0;
  for (const f of files) {
    const res = await prepareUploadFile(f);
    if (res.error) { notify?.(res.error, 'danger'); continue; }
    if (res.resized) { shrunk++; before += f.size; after += res.file.size; }
    ready.push(res.file);
  }
  if (shrunk) notify?.(`Resized ${shrunk} photo${shrunk === 1 ? '' : 's'} for upload: ${fmtFileSize(before)} → ${fmtFileSize(after)}`, 'success');
  return ready;
}

// ── Tracking files still being prepared ──────────────────────────────────────
// prepareUploadFiles is async (photos are decoded and re-encoded), so a form's
// Save can be clicked before a just-picked file has been added to the record.
// A tracker counts in-flight preparations; Save awaits idle() first, and the
// form shows a "Preparing file…" state on its Save button meanwhile.
export function createPrepTracker(onChange) {
  const inflight = new Set();
  return {
    track(promise) {
      const p = Promise.resolve(promise).finally(() => { inflight.delete(p); onChange?.(inflight.size); });
      inflight.add(p);
      onChange?.(inflight.size);
      return p;
    },
    get busy() { return inflight.size > 0; },
    // Resolves once every preparation started so far (and any started while
    // waiting) has settled. Never rejects.
    async idle() {
      while (inflight.size) await Promise.allSettled([...inflight]);
    }
  };
}

// Wires a tracker to a Save button: disabled with "Preparing file…" while
// files are being prepared, restored afterwards.
export function prepTrackerForButton(btn) {
  let label = null;
  return createPrepTracker(n => {
    if (!btn) return;
    if (n > 0) {
      if (label === null) label = btn.textContent;
      btn.textContent = 'Preparing file…';
      btn.dataset.preparing = '1';
      btn.disabled = true;
    } else if (label !== null) {
      btn.textContent = label;
      label = null;
      delete btn.dataset.preparing;
      // A save that started meanwhile keeps the button disabled until it ends.
      btn.disabled = !!btn.dataset.saving;
    }
  });
}
