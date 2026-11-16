'use strict';
// Order service: orchestrates the checkout saga (reserve stock -> authorize payment ->
// commit reservation -> confirm), idempotent checkout via Idempotency-Key, sweeper,
// and event consumers that move orders forward.
const crypto = require('crypto');
const { z } = require('zod');
const config = require('../../shared/config');
const logger = require('../../shared/logger');
const { createApp, finish, listen, asyncH, validate, requireUser, requireAdmin, HttpError } = require('../../shared/http');
const { connectMongo, mongoose, withTxn } = require('../../shared/db');
const { addOutbox, consume, startOutboxRelay, amqpConnect } = require('../../shared/events');
const { callService } = require('../../shared/clients');
const { hashBody } = require('../../shared/idem');
const { canTransition, ORDER } = require('../../shared/fsm');
const { priceLines } = require('../../shared/money');

const app = createApp('order');
const PORT = parseInt(process.env.PORT || '4006', 10);

const orderSchema = new mongoose.Schema({
  _id: String,                    // "402-1234567-1234567"
  customerId: { type: String, index: true },
  state: { type: String, index: true, default: 'PENDING_VALIDATION' },
  items: [Object],                // priced line snapshot
  address: Object,                // address snapshot
  pricing: Object,
  paymentScenario: String,
  paymentAuthorized: { type: Boolean, default: false },
  reservationExpiresAt: Date,
  cancelReason: String,
  history: [{ from: String, to: String, at: { type: Date, default: Date.now }, note: String }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { collection: 'orders', versionKey: false, _id: false });
const idemSchema = new mongoose.Schema({
  _id: String,                    // "<userId>:<key>"
  hash: String,
  orderId: String,
  createdAt: { type: Date, default: Date.now, expires: 7 * 24 * 3600 },
}, { collection: 'idempotency_keys', versionKey: false, _id: false });
const secAuditSchema = new mongoose.Schema({
  userId: String, action: String, targetId: String, at: { type: Date, default: Date.now },
}, { collection: 'security_audit', versionKey: false });
const Order = mongoose.model('Order', orderSchema);
const IdemKey = mongoose.model('OrderIdempotencyKey', idemSchema);
const SecAudit = mongoose.model('OrderSecurityAudit', secAuditSchema);

function newOrderId() {
  return `402-${1000000 + crypto.randomInt(9000000)}-${1000000 + crypto.randomInt(9000000)}`;
}

async function transition(order, to, note, session) {
  if (!canTransition(ORDER, order.state, to)) {
    logger.warn('illegal order transition suppressed', { orderId: order._id, from: order.state, to });
    return false;
  }
  const from = order.state;
  order.state = to;
  order.updatedAt = new Date();
  order.history = [...(order.history || []), { from, to, at: new Date(), note }];
  if (session) await order.save({ session }); else await order.save();
  return true;
}

async function cancelOrder(orderId, reason, correlationId, note) {
  const order = await Order.findById(orderId);
  if (!order) return;
  if (['CANCELLED', 'PAYMENT_FAILED', 'EXPIRED'].includes(order.state)) return;
  const target = reason === 'PAYMENT_FAILED' ? 'PAYMENT_FAILED' : reason === 'EXPIRED' ? 'EXPIRED' : 'CANCELLED';
  await withTxn(async (session) => {
    const fresh = await Order.findById(orderId).session(session);
    if (!fresh || !canTransition(ORDER, fresh.state, target)) return;
    const from = fresh.state;
    fresh.cancelReason = reason;
    fresh.state = target;
    fresh.updatedAt = new Date();
    fresh.history = [...(fresh.history || []), { from, to: target, at: new Date(), note: note || reason }];
    await fresh.save({ session });
    await addOutbox(session, {
      eventType: 'OrderCancelled.v1', producer: 'order', aggregateId: orderId, correlationId,
      payload: { orderId, customerId: fresh.customerId, reason },
    });
  });
}

const checkoutSchema = z.object({
  addressId: z.string().min(1),
  paymentScenario: z.enum(['success', 'failure', 'async', 'timeout']).default('success'),
});

// POST /v1/checkout
app.post('/v1/checkout', requireUser, asyncH(async (req, res) => {
  const idemKeyHeader = req.header('idempotency-key');
  if (!idemKeyHeader || idemKeyHeader.length < 8 || idemKeyHeader.length > 128) {
    throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header of 8-128 chars is required');
  }
  const body = validate(checkoutSchema, req.body);
  const hash = hashBody(body);
  const idemId = `${req.user.id}:${idemKeyHeader}`;

  // Idempotency replay
  const existing = await IdemKey.findById(idemId);
  if (existing) {
    if (existing.hash !== hash) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Same Idempotency-Key was used with a different body');
    const order = await Order.findById(existing.orderId);
    res.setHeader('Idempotent-Replayed', 'true');
    return sendOrderResponse(res, order, true);
  }

  // 1. Load cart
  const cartRes = await callService(config.services.cart, `/internal/carts/${req.user.id}`, { timeoutMs: 5000, retries: 1 });
  if (!cartRes.ok) throw new HttpError(502, 'CART_UNAVAILABLE', 'Could not load cart');
  const cartItems = cartRes.data.items || [];
  if (!cartItems.length) throw new HttpError(400, 'CART_EMPTY', 'Your cart is empty');

  // 2. Load address
  const addrRes = await callService(config.services.identity, `/internal/users/${req.user.id}/addresses/${body.addressId}`, { timeoutMs: 5000, retries: 1 });
  if (!addrRes.ok) throw new HttpError(400, 'ADDRESS_NOT_FOUND', 'Address not found');
  const address = addrRes.data.address;

  // 3. Server-side repricing
  const priceRes = await callService(config.services.catalog, `/internal/products?skus=${encodeURIComponent(cartItems.map((i) => i.sku).join(','))}`, { timeoutMs: 5000, retries: 1 });
  if (!priceRes.ok) throw new HttpError(502, 'CATALOG_UNAVAILABLE', 'Could not price order');
  const byId = new Map((priceRes.data.products || []).map((p) => [p.sku, p]));
  const { items, pricing } = priceLines(cartItems.map((i) => ({ sku: i.sku, quantity: i.quantity })), byId);

  // 4. Create order in PENDING_VALIDATION
  const orderId = newOrderId();
  const order = await Order.create({
    _id: orderId, customerId: req.user.id, state: 'PENDING_VALIDATION',
    items, address, pricing, paymentScenario: body.paymentScenario,
    history: [{ from: null, to: 'PENDING_VALIDATION', at: new Date(), note: 'Checkout started' }],
  });

  // Persist idempotency key before risky work
  try {
    await IdemKey.create({ _id: idemId, hash, orderId });
  } catch (e) {
    if (e.code === 11000) {
      // Concurrent same-key request won the race; return that order.
      const winner = await IdemKey.findById(idemId);
      const winnerOrder = winner && await Order.findById(winner.orderId);
      res.setHeader('Idempotent-Replayed', 'true');
      return sendOrderResponse(res, winnerOrder, true);
    }
    throw e;
  }

  // 5. Reserve stock (all-or-nothing)
  const reserveRes = await callService(config.services.inventory, '/internal/reservations', {
    method: 'POST', body: { orderId, items: items.map((i) => ({ sku: i.sku, quantity: i.quantity })), ttlSeconds: config.reservationTtlSeconds },
    cid: req.correlationId, timeoutMs: 8000, retries: 0,
  });
  if (!reserveRes.ok) {
    const unavailable = reserveRes.data?.error?.unavailable || reserveRes.data?.unavailable;
    await cancelOrder(orderId, 'OUT_OF_STOCK', req.correlationId, 'Insufficient stock for: ' + JSON.stringify(unavailable || []));
    const o = await Order.findById(orderId);
    return res.status(409).json({ error: { code: 'OUT_OF_STOCK', message: 'Some items are out of stock', unavailable, orderId, correlationId: req.correlationId }, order: o });
  }
  const reservationExpiresAt = reserveRes.data.reservationExpiresAt;
  await transition(order, 'INVENTORY_RESERVED', 'Stock reserved');
  order.reservationExpiresAt = reservationExpiresAt ? new Date(reservationExpiresAt) : new Date(Date.now() + config.reservationTtlSeconds * 1000);
  await order.save();

  // 6. Move to PAYMENT_PENDING and authorize
  await transition(order, 'PAYMENT_PENDING', 'Awaiting payment authorization');
  const payRes = await callService(config.services.payment, '/internal/payments/authorize', {
    method: 'POST', body: { orderId, amount: pricing.total, currency: 'INR', scenario: body.paymentScenario, customerId: req.user.id },
    cid: req.correlationId, timeoutMs: body.paymentScenario === 'timeout' ? 12000 : 6000, retries: 0,
  });
  const payStatus = payRes.data?.status;

  if (payStatus === 'AUTHORIZED') {
    const confirmed = await confirmOrder(orderId, req.correlationId);
    return sendOrderResponse(res, confirmed, false, 201);
  }
  if (payStatus === 'FAILED') {
    await cancelOrder(orderId, 'PAYMENT_FAILED', req.correlationId, 'Payment declined by provider');
    const o = await Order.findById(orderId);
    return res.status(402).json({ error: { code: 'PAYMENT_FAILED', message: 'Payment was declined', orderId, correlationId: req.correlationId }, order: o });
  }
  // Async or timeout: respond 202 pending; webhook/reconciliation/sweeper will finish.
  const o = await Order.findById(orderId);
  return res.status(202).json({ order: o, pending: true, correlationId: req.correlationId });
}));

async function confirmOrder(orderId, correlationId) {
  // Commit reservation THEN mark CONFIRMED + outbox OrderConfirmed.v1 in one transaction.
  const commitRes = await callService(config.services.inventory, `/internal/reservations/${orderId}/commit`, { method: 'POST', body: {}, cid: correlationId, timeoutMs: 8000, retries: 2 });
  if (!commitRes.ok) {
    logger.warn('reservation commit failed; sweeper will retry', { orderId, status: commitRes.status });
    return Order.findById(orderId);
  }
  // Mark CONFIRMED + emit OrderConfirmed.v1 in ONE transaction, then clear the cart.
  let justConfirmed = false;
  await withTxn(async (session) => {
    const order = await Order.findById(orderId).session(session);
    if (!order || order.state === 'CONFIRMED') return;
    if (!canTransition(ORDER, order.state, 'CONFIRMED')) { logger.warn('cannot confirm from state', { orderId, state: order.state }); return; }
    order.state = 'CONFIRMED';
    order.paymentAuthorized = true;
    order.updatedAt = new Date();
    order.history = [...(order.history || []), { from: 'PAYMENT_PENDING', to: 'CONFIRMED', at: new Date(), note: 'Payment authorized; reservation committed' }];
    await order.save({ session });
    await addOutbox(session, {
      eventType: 'OrderConfirmed.v1', producer: 'order', aggregateId: orderId, correlationId,
      payload: { orderId, customerId: order.customerId, total: order.pricing.total, currency: order.pricing.currency, items: order.items },
    });
    justConfirmed = true;
  });
  // Clear the user's cart synchronously — but only on the actual transition,
  // never on replayed confirm calls (would wipe a cart refilled afterwards).
  if (justConfirmed) {
    const confirmed = await Order.findById(orderId).lean();
    if (confirmed?.customerId) {
      callService(config.services.cart, `/internal/carts/${confirmed.customerId}`, { method: 'DELETE', timeoutMs: 3000, retries: 0 })
        .then(() => logger.info('cart cleared for order', { orderId }))
        .catch((e) => logger.warn('cart clear failed (event backstop remains)', { orderId, err: e.message }));
    }
  }
  return Order.findById(orderId);
}

function sendOrderResponse(res, order, replayed, status) {
  if (!order) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
  const state = order.state;
  if (status) return res.status(status).json({ order, ...(replayed ? { replayed: true } : {}) });
  if (state === 'CONFIRMED') return res.status(201).json({ order, ...(replayed ? { replayed: true } : {}) });
  if (['CANCELLED'].includes(state)) return res.status(409).json({ order, ...(replayed ? { replayed: true } : {}) });
  if (state === 'PAYMENT_FAILED') return res.status(402).json({ order, ...(replayed ? { replayed: true } : {}) });
  if (state === 'EXPIRED') return res.status(409).json({ order, ...(replayed ? { replayed: true } : {}) });
  return res.status(202).json({ order, pending: true, ...(replayed ? { replayed: true } : {}) });
}

// GET /v1/orders
app.get('/v1/orders', requireUser, asyncH(async (req, res) => {
  const orders = await Order.find({ customerId: req.user.id }).sort({ createdAt: -1 }).limit(50).lean();
  res.json({ orders });
}));

// GET /v1/orders/:id — owner or admin; otherwise 404 + security_audit row
app.get('/v1/orders/:id', requireUser, asyncH(async (req, res) => {
  const order = await Order.findById(req.params.id).lean();
  if (!order) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
  const isOwner = order.customerId === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) {
    await SecAudit.create({ userId: req.user.id, action: 'ORDER_READ_FORBIDDEN', targetId: order._id });
    throw new HttpError(404, 'NOT_FOUND', 'Order not found'); // do not leak existence
  }
  res.json({ order });
}));

app.get('/v1/admin/orders', requireAdmin, asyncH(async (req, res) => {
  const state = req.query.state ? String(req.query.state) : null;
  const orders = await Order.find(state ? { state } : {}).sort({ createdAt: -1 }).limit(100).lean();
  res.json({ orders });
}));

// Sweeper: every 15s — retry commit for authorized-but-unconfirmed; cancel stale PENDING_VALIDATION (>120s)
setInterval(async () => {
  try {
    const authorizedUnconfirmed = await Order.find({ state: 'PAYMENT_PENDING', paymentAuthorized: true }).limit(20);
    for (const o of authorizedUnconfirmed) await confirmOrder(o._id);
    const stale = await Order.find({ state: 'PENDING_VALIDATION', createdAt: { $lt: new Date(Date.now() - 120000) } }).limit(20);
    for (const o of stale) await cancelOrder(o._id, 'EXPIRED', undefined, 'Checkout abandoned for over 120s');
    const pendingLong = await Order.find({ state: 'PAYMENT_PENDING', createdAt: { $lt: new Date(Date.now() - 3600000) } }).limit(20);
    for (const o of pendingLong) await cancelOrder(o._id, 'EXPIRED', undefined, 'Payment pending too long');
  } catch (err) {
    logger.warn('sweeper error', { err: err.message });
  }
}, 15000).unref();

// React to reservation expiry: cancel owning order
async function handleReservationExpired(envl) {
  const orderId = (envl.payload || {}).orderId;
  if (!orderId) return;
  await cancelOrder(orderId, 'EXPIRED', envl.correlation_id, 'Reservation expired');
}

(async () => {
  await connectMongo('orders');
  await amqpConnect().catch(() => {});
  startOutboxRelay('order');
  await consume('order.payment-events', async (envl) => {
    const p = envl.payload || {};
    if (envl.event_type === 'PaymentAuthorized.v1') {
      const order = await Order.findById(p.orderId);
      if (!order) return;
      order.paymentAuthorized = true;
      order.updatedAt = new Date();
      await order.save();
      await confirmOrder(p.orderId, envl.correlation_id);
    } else if (envl.event_type === 'PaymentFailed.v1') {
      await cancelOrder(p.orderId, 'PAYMENT_FAILED', envl.correlation_id, 'Payment failed');
    }
  });
  await consume('order.inventory-events', async (envl) => {
    const p = envl.payload || {};
    if (envl.event_type === 'ReservationExpired.v1') await handleReservationExpired(envl);
    // InventoryReserved.v1: informational for the order saga (already handled synchronously)
  });
  await consume('order.tracking', async (envl) => {
    const p = envl.payload || {};
    const map = { LABELLED: 'FULFILLING', IN_TRANSIT: 'FULFILLING', OUT_FOR_DELIVERY: 'SHIPPED', DELIVERED: 'DELIVERED', CREATED: null };
    const target = map[p.status];
    if (!target) return;
    const order = await Order.findById(p.orderId);
    if (!order) return;
    if (canTransition(ORDER, order.state, target)) await transition(order, target, `Shipment status: ${p.status}`);
  });
  finish(app);
  listen(app, PORT, 'order');
})().catch((err) => { logger.error('order failed to start', { err: err.message }); process.exit(1); });
