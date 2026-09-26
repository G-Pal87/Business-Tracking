// Run with: node --test scripts/tests/*.test.mjs
// Synthetic records only; never real data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactForDebug } from '../../js/core/redact.js';

const sample = () => ({
  users: [{ id: 'usr1', username: 'alice', name: 'Alice Example', role: 'admin', passwordHash: 'h', passwordSalt: 's' }],
  tenants: [{ id: 't1', name: 'Bob Sample', email: 'bob@example.test', phone: '+1 555 0100', rent: 900, propertyId: 'p1' }],
  clients: [{ id: 'c1', name: 'Example Ltd', address: { line1: '1 Test Road', city: 'Testville' }, vatNumber: 'XX123',
    documents: [{ name: 'Lease - Bob Sample.pdf', type: 'application/pdf', path: 'documents/abc.bin', data: 'A'.repeat(400) }] }],
  properties: [{ id: 'p1', name: 'Unit 4', address: 'Somewhere 5', notes: 'call Bob' }],
  invoices: [{ id: 'i1', clientName: 'Example Ltd', total: 100, currency: 'EUR', pdfData: 'B'.repeat(300),
    lineItems: [{ description: 'Consulting for Bob', quantity: 2, rate: 50 }] }],
  strCalendars: [{ id: 's1', url: 'https://example.test/calendar/ical/1.ics?s=secret' }],
  settings: { business: { name: 'My Biz', iban: 'XX00TEST', bic: 'TESTBIC' }, fxRates: { yearRates: { 2025: 0.0025 } } },
  appConfig: { github: { owner: 'o', repo: 'r', token: 'ghp_x' } }
});

test('drops credentials and tokens', () => {
  const out = redactForDebug(sample());
  assert.ok(!('passwordHash' in out.users[0]));
  assert.ok(!('passwordSalt' in out.users[0]));
  assert.ok(!('token' in out.appConfig.github));
  assert.equal(out.appConfig.github.owner, 'o');
});

test('redacts people, contact and bank details, free text and file names', () => {
  const out = redactForDebug(sample());
  const json = JSON.stringify(out);
  for (const leak of ['alice', 'Alice Example', 'Bob Sample', 'bob@example.test', '555 0100', '1 Test Road', 'Testville',
    'XX123', 'Lease - Bob', 'Somewhere 5', 'call Bob', 'Consulting for Bob', 'XX00TEST', 'TESTBIC', 'My Biz', 'secret']) {
    assert.ok(!json.includes(leak), `leaked: ${leak}`);
  }
  assert.equal(out.clients[0].documents[0].data, '[removed: 400 chars]');
  assert.equal(out.invoices[0].pdfData, '[removed: 300 chars]');
});

test('keeps structure, ids, amounts and non-personal names', () => {
  const out = redactForDebug(sample());
  assert.equal(out.users[0].id, 'usr1');
  assert.equal(out.users[0].role, 'admin');
  assert.equal(out.tenants[0].rent, 900);
  assert.equal(out.tenants[0].propertyId, 'p1');
  assert.equal(out.properties[0].name, 'Unit 4');
  assert.equal(out.invoices[0].total, 100);
  assert.equal(out.invoices[0].lineItems[0].rate, 50);
  assert.equal(out.clients[0].documents[0].path, 'documents/abc.bin');
  assert.equal(out.settings.fxRates.yearRates[2025], 0.0025);
});

test('does not modify its input', () => {
  const input = sample();
  const before = JSON.stringify(input);
  redactForDebug(input);
  assert.equal(JSON.stringify(input), before);
});
