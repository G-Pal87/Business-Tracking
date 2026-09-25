// Run with: node --test scripts/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney } from '../../js/core/data.js';
import { escapeHtml } from '../../js/core/ui.js';

test('formatMoney never echoes an invalid currency', () => {
  const out = formatMoney(1500, '<img src=x onerror=alert(1)>');
  assert.equal(out, '1,500.00');
  assert.ok(!/[<>"']/.test(formatMoney(1, '"><b>')));
  assert.equal(formatMoney(12.5, null), '12.50');
  assert.equal(formatMoney(12.5, ''), '12.50');
  assert.equal(formatMoney('abc', 'bad!'), '0.00');
});

test('formatMoney still formats valid codes', () => {
  assert.equal(formatMoney(1500, 'EUR'), '€1,500.00');
  assert.equal(formatMoney(1500, 'eur'), '€1,500.00');
  assert.match(formatMoney(1500, 'HUF'), /^HUF\s1,500$/);
  assert.equal(formatMoney(3), '€3.00');
});

test('escapeHtml escapes every HTML-significant character', () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(0), '0');
});
