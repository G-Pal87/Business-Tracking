import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { nextStamp } = await import('../../js/core/data.js');

test('nextStamp is monotonic when the clock is behind (Y2)', () => {
  assert.equal(nextStamp(1000, 500), 1001);
  assert.equal(nextStamp(1000, 2000), 2000);
  assert.equal(nextStamp(undefined, 5), 5);
});
