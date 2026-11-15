'use strict';
// Forward-only finite state machines for orders, payments and shipments.

const ORDER = {
  PENDING_VALIDATION: ['INVENTORY_RESERVED', 'CANCELLED', 'PAYMENT_FAILED', 'EXPIRED'],
  INVENTORY_RESERVED: ['PAYMENT_PENDING', 'CANCELLED', 'PAYMENT_FAILED', 'EXPIRED'],
  PAYMENT_PENDING: ['CONFIRMED', 'CANCELLED', 'PAYMENT_FAILED', 'EXPIRED'],
  CONFIRMED: ['FULFILLING', 'CANCELLED'],
  FULFILLING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
  PAYMENT_FAILED: [],
  EXPIRED: [],
};

const PAYMENT = {
  CREATED: ['PROCESSING', 'AUTHORIZED', 'FAILED', 'VOIDED'],
  PROCESSING: ['AUTHORIZED', 'FAILED', 'VOIDED'],
  AUTHORIZED: ['CAPTURED', 'VOIDED'],
  CAPTURED: [],
  FAILED: [],
  VOIDED: [],
};

const SHIPMENT = {
  CREATED: ['LABELLED', 'EXCEPTION'],
  LABELLED: ['IN_TRANSIT', 'EXCEPTION'],
  IN_TRANSIT: ['OUT_FOR_DELIVERY', 'EXCEPTION'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'EXCEPTION'],
  DELIVERED: ['RETURNED'],
  EXCEPTION: ['IN_TRANSIT', 'RETURNED'],
  RETURNED: [],
};

const RESERVATION = {
  ACTIVE: ['COMMITTED', 'RELEASED', 'EXPIRED'],
  COMMITTED: [],
  RELEASED: [],
  EXPIRED: [],
};

function canTransition(machine, from, to) {
  const allowed = machine[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

function assertTransition(machine, from, to, what = 'state') {
  if (!canTransition(machine, from, to)) {
    const err = new Error(`Illegal ${what} transition ${from} -> ${to}`);
    err.code = 'ILLEGAL_TRANSITION';
    err.from = from;
    err.to = to;
    throw err;
  }
  return to;
}

module.exports = { ORDER, PAYMENT, SHIPMENT, RESERVATION, canTransition, assertTransition };
