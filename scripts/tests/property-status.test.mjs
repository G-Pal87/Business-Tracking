import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { setDb } = await import('../../js/core/state.js');
const data = await import('../../js/core/data.js');

// Property status follows its leases: a tenant makes it Active, no lease on
// an Active long-term flat makes it Vacant; Sold / Renovation-without-tenant
// stay as set.
const D = '2026-10-30';
const load = (properties, tenants) => setDb({ settings: {}, properties, tenants, payments: [], expenses: [] });

test('a running lease makes a Renovation / Vacant flat Active', () => {
  load([{ id: 'a', type: 'long_term', status: 'renovation' }, { id: 'b', type: 'long_term', status: 'vacant' }],
    [{ id: 't1', propertyId: 'a', status: 'active', leaseStartDate: '2026-10-03', leaseEndDate: '2027-10-02' },
     { id: 't2', propertyId: 'b', status: 'active', leaseStartDate: '2026-01-01' }]);
  assert.equal(data.expectedPropertyStatus(data.byId('properties', 'a'), D), 'active');
  assert.deepEqual(data.syncPropertyStatus('a', D), { from: 'renovation', to: 'active' });
  assert.equal(data.byId('properties', 'a').status, 'active');
  assert.equal(data.syncPropertyStatus('b', D).to, 'active');
});

test('an Active long-term flat with no running lease becomes Vacant; short-term and sold untouched', () => {
  load([{ id: 'a', type: 'long_term', status: 'active' }, { id: 's', type: 'short_term', status: 'active' }, { id: 'x', type: 'long_term', status: 'sold' }],
    [{ id: 't1', propertyId: 'a', status: 'past', leaseStartDate: '2025-01-01', leaseEndDate: '2026-09-23', terminationDate: '2026-09-23' }]);
  assert.equal(data.expectedPropertyStatus(data.byId('properties', 'a'), D), 'vacant');
  assert.equal(data.expectedPropertyStatus(data.byId('properties', 's'), D), null);
  assert.equal(data.expectedPropertyStatus(data.byId('properties', 'x'), D), null);
});

test('renovation without a tenant stays; prospective and future leases do not count; terminated leases end early', () => {
  load([{ id: 'a', type: 'long_term', status: 'renovation' }, { id: 'b', type: 'long_term', status: 'active' }],
    [{ id: 'p', propertyId: 'a', status: 'prospective', leaseStartDate: '2026-01-01' },
     { id: 'f', propertyId: 'a', status: 'active', leaseStartDate: '2026-12-01' },
     { id: 'k', propertyId: 'b', status: 'past', leaseStartDate: '2025-01-01', leaseEndDate: '2027-01-01', terminationDate: '2026-10-15' }]);
  assert.equal(data.expectedPropertyStatus(data.byId('properties', 'a'), D), null);
  assert.equal(data.currentLeases('a', D).length, 0);
  assert.equal(data.currentLeases('b', D).length, 0);          // terminated 15 Oct
  assert.equal(data.expectedPropertyStatus(data.byId('properties', 'b'), D), 'vacant');
});
