// Upload preparation: storage-path extensions, lossless metadata stripping,
// header-only image sizes and the in-flight preparation tracker.
// Synthetic bytes only.
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const {
  safeStorageExt, storagePathWithExt, stripJpegMetadata, stripPngMetadata, imageDisplaySize,
  prepareUploadFile, prepareUploadFiles, createPrepTracker, prepTrackerForButton, MAX_UPLOAD_BYTES
} = await import('../../js/core/files.js');

const u8 = (...parts) => new Uint8Array(parts.flatMap(p => typeof p === 'string' ? [...p].map(c => c.charCodeAt(0)) : p));
const seg = (marker, payload) => { const len = payload.length + 2; return [0xFF, marker, len >> 8, len & 0xFF, ...payload]; };
const str = s => [...s].map(c => c.charCodeAt(0));

// Minimal EXIF APP1 payload: big-endian TIFF, IFD0 with Orientation and a
// fake GPS IFD pointer tag, followed by some "GPS" text.
function exifPayload(orientation) {
  return [...str('Exif'), 0, 0, 0x4D, 0x4D, 0, 42, 0, 0, 0, 8, 0, 2,
    0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0,
    0x88, 0x25, 0, 4, 0, 0, 0, 1, 0, 0, 0, 0,
    0, 0, 0, 0, ...str('GPS 51.5N 0.12W')];
}
// SOF0 with height 3000, width 4000.
const SOF0 = seg(0xC0, [8, 0x0B, 0xB8, 0x0F, 0xA0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
const SOS_AND_DATA = [0xFF, 0xDA, 0, 8, 1, 1, 0, 0, 0x3F, 0, 0x12, 0x34, 0xFF, 0x00, 0x56, 0xFF, 0xD9];
function jpeg({ orientation = 1, app0 = true, xmp = false, comment = false } = {}) {
  return u8([0xFF, 0xD8],
    app0 ? seg(0xE0, [...str('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]) : [],
    seg(0xE1, exifPayload(orientation)),
    xmp ? seg(0xE1, [...str('http://ns.adobe.com/xap/1.0/'), 0, ...str('<x:xmpmeta>location</x:xmpmeta>')]) : [],
    comment ? seg(0xFE, str('taken at home')) : [],
    seg(0xDB, new Array(65).fill(1)),
    SOF0, SOS_AND_DATA);
}
const has = (bytes, text) => Buffer.from(bytes).includes(Buffer.from(text));

test('storage extension: only 1-5 plain letters/digits from the last segment, else MIME, else none', () => {
  assert.equal(safeStorageExt('Receipt.PDF', 'application/pdf'), 'pdf');
  assert.equal(safeStorageExt('photo.jpeg', ''), 'jpeg');
  assert.equal(safeStorageExt('scan of passport', 'image/jpeg'), 'jpg');      // no dot: MIME
  assert.equal(safeStorageExt('lease.john smith', 'application/pdf'), 'pdf'); // spaces: MIME
  assert.equal(safeStorageExt('a.b.verylongext', ''), '');                    // >5 chars, unknown MIME
  assert.equal(safeStorageExt('notes', ''), '');
  assert.equal(safeStorageExt('dir.v2/file', 'text/plain'), 'txt');          // dot only in a folder part
  assert.equal(safeStorageExt('x.tar.gz', ''), 'gz');
  assert.equal(safeStorageExt('report.pdf ', 'application/pdf'), 'pdf');     // "pdf " fails the pattern → MIME
  assert.equal(safeStorageExt('café.p€f', ''), '');
  assert.equal(safeStorageExt(undefined, undefined), '');
  assert.equal(storagePathWithExt('expenses/receipts/e1', 'Mum’s receipt', 'image/png'), 'expenses/receipts/e1.png');
  assert.equal(storagePathWithExt('Clients/c1/d1', 'secret name', ''), 'Clients/c1/d1');
});

test('JPEG: EXIF, XMP and comments are removed losslessly; image data untouched', () => {
  const src = jpeg({ xmp: true, comment: true });
  const out = stripJpegMetadata(src);
  assert.ok(has(src, 'GPS 51.5N') && has(src, 'xmpmeta') && has(src, 'taken at home'));
  assert.ok(!has(out, 'GPS 51.5N') && !has(out, 'xmpmeta') && !has(out, 'taken at home') && !has(out, 'Exif'));
  assert.ok(has(out, 'JFIF'));
  assert.deepEqual([...out.slice(-SOS_AND_DATA.length)], SOS_AND_DATA);
  assert.deepEqual(imageDisplaySize(out), { width: 4000, height: 3000 });
});

test('JPEG: a rotated photo keeps only its orientation tag', () => {
  const out = stripJpegMetadata(jpeg({ orientation: 6, app0: false }));
  assert.ok(!has(out, 'GPS 51.5N'));
  assert.ok(has(out, 'Exif'));
  // Orientation still read back as 6 → displayed size swapped.
  assert.deepEqual(imageDisplaySize(out), { width: 3000, height: 4000 });
  assert.deepEqual(imageDisplaySize(jpeg({ orientation: 6 })), { width: 3000, height: 4000 });
  // Orientation block sits right after SOI when there's no APP0.
  assert.deepEqual([...out.slice(0, 4)], [0xFF, 0xD8, 0xFF, 0xE1]);
  // …and after APP0 when there is one.
  const withApp0 = stripJpegMetadata(jpeg({ orientation: 3 }));
  assert.equal(withApp0[2 + 2 + ((withApp0[4] << 8) | withApp0[5]) + 1], 0xE1);
});

test('JPEG without metadata is returned as-is; garbage is null', () => {
  const clean = u8([0xFF, 0xD8], seg(0xDB, new Array(65).fill(1)), SOF0, SOS_AND_DATA);
  assert.equal(stripJpegMetadata(clean), clean);
  assert.equal(stripJpegMetadata(u8('not a jpeg')), null);
  assert.equal(stripJpegMetadata(u8([0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF])), null); // truncated segment
});

test('PNG: eXIf chunk removed, everything else kept', () => {
  const chunk = (type, data) => { const n = data.length; return [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255, ...str(type), ...data, 0, 0, 0, 0]; };
  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  const ihdr = chunk('IHDR', [0, 0, 1, 0, 0, 0, 0, 200, 8, 6, 0, 0, 0]);
  const src = u8(sig, ihdr, chunk('eXIf', str('MM GPS 51.5N')), chunk('IDAT', [1, 2, 3]), chunk('IEND', []));
  const out = stripPngMetadata(src);
  assert.ok(!has(out, 'GPS') && has(out, 'IDAT') && has(out, 'IEND'));
  assert.equal(out.length, src.length - 12 - 12);
  assert.deepEqual(imageDisplaySize(out), { width: 256, height: 200 });
  const noExif = u8(sig, ihdr, chunk('IEND', []));
  assert.equal(stripPngMetadata(noExif), noExif);
});

test('prepareUploadFile strips a small JPEG without resizing; other files pass through', async () => {
  const photo = new File([jpeg({ xmp: true })], 'IMG_0001.JPG', { type: 'image/jpeg' });
  const res = await prepareUploadFile(photo);
  assert.equal(res.resized, false);
  assert.equal(res.file.name, 'IMG_0001.JPG');
  assert.equal(res.file.type, 'image/jpeg');
  const bytes = new Uint8Array(await res.file.arrayBuffer());
  assert.ok(!has(bytes, 'GPS 51.5N') && !has(bytes, 'xmpmeta'));

  const pdf = new File([u8('%PDF-1.7\n')], 'a.pdf', { type: 'application/pdf' });
  assert.equal((await prepareUploadFile(pdf)).file, pdf);

  const big = { name: 'huge.pdf', size: MAX_UPLOAD_BYTES + 1, type: 'application/pdf' };
  assert.match((await prepareUploadFile(big)).error, /limit is 20\.0 MB/);

  const notes = [];
  const ready = await prepareUploadFiles([photo, pdf], (m, k) => notes.push([m, k]));
  assert.equal(ready.length, 2);
  assert.deepEqual(notes, []); // stripping alone isn't reported as a resize
});

test('prep tracker: idle() waits for every in-flight preparation, including late ones', async () => {
  const counts = [];
  const t = createPrepTracker(n => counts.push(n));
  let release1, release2;
  t.track(new Promise(r => { release1 = r; }));
  assert.equal(t.busy, true);
  let idle = false;
  const done = t.idle().then(() => { idle = true; });
  await new Promise(r => setTimeout(r, 5));
  t.track(new Promise(r => { release2 = r; }));
  release1();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(idle, false);
  release2();
  await done;
  assert.equal(idle, true);
  assert.equal(t.busy, false);
  assert.deepEqual(counts, [1, 2, 1, 0]);
  // A rejected preparation doesn't make idle() reject.
  t.track(Promise.reject(new Error('x'))).catch(() => {});
  await t.idle();
});

test('PNG: a rotated eXIf (orientation > 1) is kept, so the image doesn\'t display sideways', () => {
  const chunk = (type, data) => { const n = data.length; return [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255, ...str(type), ...data, 0, 0, 0, 0]; };
  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  const ihdr = chunk('IHDR', [0, 0, 1, 0, 0, 0, 0, 200, 8, 6, 0, 0, 0]);
  // Big-endian TIFF: 1 IFD entry, Orientation (0x0112) SHORT = 6.
  const tiff = [0x4D, 0x4D, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0];
  const src = u8(sig, ihdr, chunk('eXIf', tiff), chunk('IEND', []));
  assert.equal(stripPngMetadata(src), src);
});

test('storage path from an old-style path segment never carries file-name text', () => {
  assert.equal(storagePathWithExt('Properties/p1/doc1', 'Flat 2.0/lease'.split('/').pop(), ''), 'Properties/p1/doc1');
  assert.equal(storagePathWithExt('Properties/p1/doc1', 'lease.john smith', ''), 'Properties/p1/doc1');
  assert.equal(storagePathWithExt('expenses/receipts/e1', 'scan of passport', 'image/jpeg'), 'expenses/receipts/e1.jpg');
});

test('prep tracker for a button: finishing a preparation during a save keeps Save disabled', async () => {
  const btn = { textContent: 'Save', disabled: false, dataset: {} };
  const tr = prepTrackerForButton(btn);
  let release; tr.track(new Promise(r => { release = r; }));
  assert.equal(btn.disabled, true);
  btn.dataset.saving = '1';           // a save starts while the file is preparing
  release(); await tr.idle();
  assert.equal(btn.disabled, true, 'still saving');
  assert.equal(btn.textContent, 'Save');
  delete btn.dataset.saving;
  let release2; tr.track(new Promise(r => { release2 = r; }));
  release2(); await tr.idle();
  assert.equal(btn.disabled, false, 'idle and not saving → enabled');
});
