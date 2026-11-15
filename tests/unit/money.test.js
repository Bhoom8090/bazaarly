'use strict';
const { priceLines, FREE_SHIPPING_THRESHOLD, SHIPPING_FEE } = require('../../shared/money');

const products = {
  'SKU-A': { sku: 'SKU-A', productId: 'p_a', title: 'A', price: 10000 },
  'SKU-B': { sku: 'SKU-B', productId: 'p_b', title: 'B', price: 20000 },
};

test('prices lines and computes subtotal', () => {
  const { items, pricing } = priceLines([{ sku: 'SKU-A', quantity: 2 }], products);
  expect(items[0].lineTotal).toBe(20000);
  expect(pricing.subtotal).toBe(20000);
  expect(pricing.currency).toBe('INR');
});

test('adds shipping fee below the free-shipping threshold', () => {
  const { pricing } = priceLines([{ sku: 'SKU-A', quantity: 1 }], products);
  expect(pricing.shipping).toBe(SHIPPING_FEE);
  expect(pricing.total).toBe(10000 + SHIPPING_FEE);
});

test('free shipping at/above ₹499', () => {
  const big = { 'SKU-C': { sku: 'SKU-C', productId: 'p_c', title: 'C', price: FREE_SHIPPING_THRESHOLD } };
  const { pricing } = priceLines([{ sku: 'SKU-C', quantity: 1 }], big);
  expect(pricing.shipping).toBe(0);
  expect(pricing.total).toBe(FREE_SHIPPING_THRESHOLD);
});

test('GST shown is extracted from inclusive amounts (18%)', () => {
  const { pricing } = priceLines([{ sku: 'SKU-A', quantity: 1 }], products);
  const gross = pricing.subtotal + pricing.shipping;
  expect(pricing.tax).toBe(Math.round((gross * 0.18) / 1.18));
});

test('unknown SKU throws UNKNOWN_SKU', () => {
  expect(() => priceLines([{ sku: 'NOPE', quantity: 1 }], products)).toThrow(/Unknown SKU/);
});

test('quantity is capped at 10', () => {
  const { items } = priceLines([{ sku: 'SKU-A', quantity: 99 }], products);
  expect(items[0].quantity).toBe(10);
});
