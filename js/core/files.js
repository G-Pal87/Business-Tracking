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
// GIFs may be animated and SVGs aren't raster — both are uploaded as-is.
const RESIZABLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function fmtFileSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// Resolves to { file } ready to upload — a re-encoded JPEG (name ending .jpg)
// when a photo could be made smaller, else the original — or { error } when
// the file is over the limit. Never throws: if the browser can't decode the
// image, the original is used unchanged.
export async function prepareUploadFile(file) {
  if (file.size > MAX_UPLOAD_BYTES) {
    return { error: `${file.name} is ${fmtFileSize(file.size)} — the limit is ${fmtFileSize(MAX_UPLOAD_BYTES)} per file. Compress or split it first.` };
  }
  if (!RESIZABLE_TYPES.has(file.type) || typeof createImageBitmap !== 'function') return { file };
  try {
    const bmp = await createImageBitmap(file); // applies EXIF orientation
    const scale = Math.min(1, RESIZE_MAX_PX / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // JPEG has no transparency — PNG see-through areas become white, not black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
    // Keep the original whenever re-encoding doesn't actually help (e.g. a
    // small screenshot that PNG already stores compactly).
    if (!blob || blob.size >= file.size) return { file };
    const name = file.name.replace(/\.[^./]+$/, '') + '.jpg';
    return { file: new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified }) };
  } catch {
    return { file };
  }
}

// prepareUploadFile over several files, with one summary toast-ready message
// for what was shrunk and one per rejected file. `notify(msg, kind)` shows them.
export async function prepareUploadFiles(files, notify) {
  const ready = [];
  let before = 0, after = 0, shrunk = 0;
  for (const f of files) {
    const res = await prepareUploadFile(f);
    if (res.error) { notify?.(res.error, 'danger'); continue; }
    if (res.file !== f) { shrunk++; before += f.size; after += res.file.size; }
    ready.push(res.file);
  }
  if (shrunk) notify?.(`Resized ${shrunk} photo${shrunk === 1 ? '' : 's'} for upload: ${fmtFileSize(before)} → ${fmtFileSize(after)}`, 'success');
  return ready;
}
