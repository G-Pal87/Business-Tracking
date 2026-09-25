// Unit tests for js/core/csv.js — synthetic inline values only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  csvCell, toCsv, parseCsvRows, parseAmountSigned, findAmountsInText,
  detectDateOrder, parseImportDate
} from '../../js/core/csv.js';

test('csvCell neutralises formula-leading text', () => {
  assert.equal(csvCell('=HYPERLINK("http://x","y")'), `"'=HYPERLINK(""http://x"",""y"")"`);
  assert.equal(csvCell('+1 555'), `"'+1 555"`);
  assert.equal(csvCell('@SUM(A1)'), `"'@SUM(A1)"`);
  assert.equal(csvCell('\tcmd'), `"'\tcmd"`);
  assert.equal(csvCell('\rcmd'), `"'\rcmd"`);
  assert.equal(csvCell('- late checkout'), `"'- late checkout"`);
});

test('csvCell keeps real numbers numeric', () => {
  assert.equal(csvCell(-12.5), '"-12.5"');
  assert.equal(csvCell('-12.50'), '"-12.50"');
  assert.equal(csvCell('+3'), '"+3"');
  assert.equal(csvCell(0), '"0"');
  assert.equal(csvCell(NaN), '""');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(undefined), '""');
});

test('toCsv quotes commas, quotes and newlines', () => {
  assert.equal(toCsv([['a,b', 'say "hi"'], ['line1\nline2', 7]]), `"a,b","say ""hi"""\r\n"line1\nline2","7"`);
});

test('parseCsvRows handles quoted newlines and reports unterminated quotes', () => {
  const ok = parseCsvRows('﻿h1,h2\r\n"a\nb",c\n');
  assert.deepEqual(ok.rows, [['h1', 'h2'], ['a\nb', 'c']]);
  assert.equal(ok.unterminatedQuote, 0);
  const bad = parseCsvRows('h1,h2\nx,y\n"open,z\nq,r\n');
  assert.equal(bad.unterminatedQuote, 3);
});

test('parseAmountSigned: separators', () => {
  assert.equal(parseAmountSigned('1,234.56'), 1234.56);
  assert.equal(parseAmountSigned('1.234,56'), 1234.56);
  assert.equal(parseAmountSigned('1234,56'), 1234.56);
  assert.equal(parseAmountSigned('1,234'), 1234);
  assert.equal(parseAmountSigned('150.000'), 150000);
  assert.equal(parseAmountSigned('1.500.000'), 1500000);
  assert.equal(parseAmountSigned('150 000 Ft'), 150000);
  assert.equal(parseAmountSigned('12.5'), 12.5);
  assert.equal(parseAmountSigned('12.50'), 12.5);
  assert.equal(parseAmountSigned('€ 99'), 99);
  assert.equal(parseAmountSigned(''), 0);
  assert.equal(parseAmountSigned('n/a'), 0);
});

test('parseAmountSigned: sign only at the edges', () => {
  assert.equal(parseAmountSigned('-12.34'), -12.34);
  assert.equal(parseAmountSigned('−12.34'), -12.34);
  assert.equal(parseAmountSigned('€-12.34'), -12.34);
  assert.equal(parseAmountSigned('-€12.34'), -12.34);
  assert.equal(parseAmountSigned('12.34-'), -12.34);
  assert.equal(parseAmountSigned('(12.34)'), -12.34);
  assert.equal(parseAmountSigned('EUR 12.34 - EUR'), -12.34);
  assert.ok(parseAmountSigned('12-34') > 0, 'mid-field hyphen is not a minus');
  assert.equal(parseAmountSigned('-0'), 0);
});

test('findAmountsInText: currency amounts in US/EU/HUF formats', () => {
  const v = s => findAmountsInText(s).map(a => a.value);
  assert.deepEqual(v('Cleaning  €1,234.56'), [1234.56]);
  assert.deepEqual(v('Cleaning  1.234,56 €'), [1234.56]);
  assert.deepEqual(v('Consulting 2 x 150.000 Ft 300.000 Ft'), [150000, 300000]);
  assert.deepEqual(v('Consulting HUF 150 000'), [150000]);
  assert.deepEqual(v('Rent 150 000 Ft'), [150000]);
  assert.deepEqual(v('Service EUR 80.00 EUR 160.00'), [80, 160]);
  assert.deepEqual(v('Design $400'), [400]);
});

test('findAmountsInText: bare OCR numbers', () => {
  const v = s => findAmountsInText(s).map(a => a.value);
  assert.deepEqual(v('Design work 13,400.00'), [13400]);
  assert.deepEqual(v('Design work 13.400,00'), [13400]);
  assert.deepEqual(v('Hours 2.00 50.00 100.00'), [2, 50, 100]);
  assert.deepEqual(v('Tiny 0.50'), []);
  assert.deepEqual(v('No amounts here'), []);
});

test('findAmountsInText spans cover the matched text', () => {
  const line = 'Item 1.234,56 €';
  const [a] = findAmountsInText(line);
  assert.equal(line.slice(a.index, a.index + a.length).trim(), '1.234,56 €');
});

test('detectDateOrder', () => {
  assert.deepEqual(detectDateOrder(['02/13/2026', '01/05/2026']), { dayFirst: false, ambiguous: false, conflicting: false });
  assert.deepEqual(detectDateOrder(['13/02/2026', '01/05/2026']), { dayFirst: true, ambiguous: false, conflicting: false });
  assert.deepEqual(detectDateOrder(['01/02/2026', '03/04/2026']), { dayFirst: false, ambiguous: true, conflicting: false });
  assert.deepEqual(detectDateOrder(['13/02/2026', '02/13/2026']), { dayFirst: false, ambiguous: false, conflicting: true });
  assert.deepEqual(detectDateOrder(['2026-02-13', '']), { dayFirst: false, ambiguous: false, conflicting: false });
});

test('parseImportDate validates and honours order', () => {
  assert.equal(parseImportDate('02/13/2026'), '2026-02-13');
  assert.equal(parseImportDate('13/02/2026'), null);             // month 13
  assert.equal(parseImportDate('13/02/2026', { dayFirst: true }), '2026-02-13');
  assert.equal(parseImportDate('3.4.2026', { dayFirst: true }), '2026-04-03');
  assert.equal(parseImportDate('02/30/2026'), null);             // 30 Feb
  assert.equal(parseImportDate('02/29/2028'), '2028-02-29');     // leap year
  assert.equal(parseImportDate('2026-02-13'), '2026-02-13');
  assert.equal(parseImportDate('2026-02-13T23:30:00Z'), '2026-02-13');
  assert.equal(parseImportDate('2026-13-02'), null);
  assert.equal(parseImportDate('2026/2/3'), '2026-02-03');
  assert.equal(parseImportDate('Feb 13, 2026'), '2026-02-13');
  assert.equal(parseImportDate('TBD'), null);
  assert.equal(parseImportDate('12'), null);
  assert.equal(parseImportDate(''), null);
});
