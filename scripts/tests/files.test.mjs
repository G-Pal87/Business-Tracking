// Run with: node --test scripts/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniffPreviewMime, safeDownloadName } from '../../js/core/files.js';

const bytes = (...parts) => new Uint8Array(parts.flatMap(p => typeof p === 'string' ? [...p].map(c => c.charCodeAt(0)) : p));

test('recognises the allow-listed formats by their magic bytes', () => {
  assert.equal(sniffPreviewMime(bytes('%PDF-1.7\n')), 'application/pdf');
  assert.equal(sniffPreviewMime(bytes([0xEF, 0xBB, 0xBF], '\n%PDF-1.4')), 'application/pdf');
  assert.equal(sniffPreviewMime(bytes([0x89], 'PNG', [0x0D, 0x0A, 0x1A, 0x0A, 0, 0])), 'image/png');
  assert.equal(sniffPreviewMime(bytes([0xFF, 0xD8, 0xFF, 0xE0])), 'image/jpeg');
  assert.equal(sniffPreviewMime(bytes('GIF89a')), 'image/gif');
  assert.equal(sniffPreviewMime(bytes('GIF87a')), 'image/gif');
  assert.equal(sniffPreviewMime(bytes('RIFF', [1, 2, 3, 4], 'WEBPVP8 ')), 'image/webp');
});

test('rejects anything else, whatever it claims to be', () => {
  assert.equal(sniffPreviewMime(bytes('<!doctype html><script>alert(1)</script>')), null);
  assert.equal(sniffPreviewMime(bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(sniffPreviewMime(bytes('RIFF', [1, 2, 3, 4], 'WAVEfmt ')), null);
  assert.equal(sniffPreviewMime(bytes('GIF89')), null);
  assert.equal(sniffPreviewMime(bytes('PK', [3, 4])), null); // docx/xlsx/zip
  assert.equal(sniffPreviewMime(new Uint8Array()), null);
  assert.equal(sniffPreviewMime(undefined), null);
  // "%PDF-" past the first 1 KB doesn't count.
  const late = new Uint8Array(2048);
  late.set(bytes('%PDF-1.4'), 1500);
  assert.equal(sniffPreviewMime(late), null);
});

test('accepts an ArrayBuffer', () => {
  assert.equal(sniffPreviewMime(bytes('%PDF-1.5').buffer), 'application/pdf');
});

test('safeDownloadName strips paths, control characters and leading dots', () => {
  assert.equal(safeDownloadName('../../etc/passwd'), '-..-etc-passwd');
  assert.equal(safeDownloadName('a\u0000b\nc.pdf'), 'abc.pdf');
  assert.equal(safeDownloadName('.htaccess'), 'htaccess');
  assert.equal(safeDownloadName('C:\\x\\y.txt'), 'C--x-y.txt');
  assert.equal(safeDownloadName(''), 'file');
  assert.equal(safeDownloadName(null, 'receipt'), 'receipt');
  const long = safeDownloadName('x'.repeat(300) + '.docx');
  assert.equal(long.length, 150);
  assert.ok(long.endsWith('.docx'));
});
