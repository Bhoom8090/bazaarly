'use strict';
const { hashBody, stableStringify } = require('../../shared/idem');

test('hash is stable regardless of key order', () => {
  const a = hashBody({ addressId: 'a1', paymentScenario: 'success' });
  const b = hashBody({ paymentScenario: 'success', addressId: 'a1' });
  expect(a).toBe(b);
});

test('different bodies produce different hashes', () => {
  const a = hashBody({ addressId: 'a1', paymentScenario: 'success' });
  const b = hashBody({ addressId: 'a1', paymentScenario: 'failure' });
  expect(a).not.toBe(b);
});

test('arrays are order-sensitive (correct for items)', () => {
  const a = hashBody({ items: [1, 2] });
  const b = hashBody({ items: [2, 1] });
  expect(a).not.toBe(b);
});

test('canonical stringify handles nested objects', () => {
  expect(stableStringify({ b: { d: 2, c: 1 }, a: 1 })).toBe('{"a":1,"b":{"c":1,"d":2}}');
});

test('hash is 64 hex chars (sha256)', () => {
  expect(hashBody({})).toMatch(/^[0-9a-f]{64}$/);
});
