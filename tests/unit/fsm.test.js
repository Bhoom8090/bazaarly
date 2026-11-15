'use strict';
const { canTransition, assertTransition, ORDER, PAYMENT, SHIPMENT } = require('../../shared/fsm');

test('order happy path is allowed step by step', () => {
  const path = ['PENDING_VALIDATION', 'INVENTORY_RESERVED', 'PAYMENT_PENDING', 'CONFIRMED', 'FULFILLING', 'SHIPPED', 'DELIVERED'];
  for (let i = 0; i < path.length - 1; i++) {
    expect(canTransition(ORDER, path[i], path[i + 1])).toBe(true);
  }
});

test('terminal states have no outbound transitions', () => {
  for (const terminal of ['DELIVERED', 'CANCELLED', 'PAYMENT_FAILED', 'EXPIRED']) {
    expect(ORDER[terminal]).toEqual([]);
  }
});

test('illegal order transition throws with context', () => {
  expect(() => assertTransition(ORDER, 'DELIVERED', 'PENDING_VALIDATION', 'order')).toThrow(/Illegal/);
});

test('payment state machine: forward only', () => {
  expect(canTransition(PAYMENT, 'CREATED', 'PROCESSING')).toBe(true);
  expect(canTransition(PAYMENT, 'PROCESSING', 'AUTHORIZED')).toBe(true);
  expect(canTransition(PAYMENT, 'AUTHORIZED', 'CAPTURED')).toBe(true);
  expect(canTransition(PAYMENT, 'CAPTURED', 'VOIDED')).toBe(false);   // captured is terminal
  expect(canTransition(PAYMENT, 'VOIDED', 'AUTHORIZED')).toBe(false); // terminal wins
  expect(canTransition(PAYMENT, 'FAILED', 'AUTHORIZED')).toBe(false);
});

test('shipment state machine: exception can recover, delivered can return', () => {
  expect(canTransition(SHIPMENT, 'IN_TRANSIT', 'OUT_FOR_DELIVERY')).toBe(true);
  expect(canTransition(SHIPMENT, 'OUT_FOR_DELIVERY', 'DELIVERED')).toBe(true);
  expect(canTransition(SHIPMENT, 'DELIVERED', 'RETURNED')).toBe(true);
  expect(canTransition(SHIPMENT, 'RETURNED', 'DELIVERED')).toBe(false);
  expect(canTransition(SHIPMENT, 'EXCEPTION', 'IN_TRANSIT')).toBe(true);
});
