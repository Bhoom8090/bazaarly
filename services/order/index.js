'use strict';
// Order service: checkout saga (reserve stock -> authorize payment -> commit -> confirm),
// idempotent checkout via Idempotency-Key, idempotency keys, sweeper, event consumers.
require('../../shared/telemetry');
const crypto = require('crypto');
const { z } = require('zod');
const config = require('../../shared/config');
const logger = require('../../shared/logger');
const { createApp, finish, listen, asyncH, validate, requireUser, requireAdmin, HttpError } = require('../../shared/http');
const { connectDb, withTxn, ensureEventTables } = require('../../shared/db');
const { addOutbox, consume, startOutboxRelay, amqpConnect } = require('../../shared/events');
const { callService } = require('../../shared/clients');
const { hashBody } = require('../../shared/idem');
const { canTransition, ORDER } = require('../../shared/fsm');
const { priceLines } = require('../../shared/money');

const app = createApp('order');
const PORT = parseInt(process.env.PORT || '4006', 10);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id                      TEXT PRIMARY KEY,
  customer_id             TEXT NOT NULL,
  state                   TEXT NOT NULL DEFAULT 'PENDING_VALIDATION',
  items                   JSONB NOT NULL,
  address                 JSONB NOT NULL,
  pricing                 JSONB NOT NULL,
  payment_scenario        TEXT,
  payment_authorized      BOOLEAN NOT NULL DEFAULT false,
  reservation_expires_at  TIMESTAMPTZ,
  cancel_reason           TEXT,
  history                 JSONB NOT NULL DEFAULT '[]',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_state_idx ON orders (state);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         TEXT PRIMARY KEY,
  hash        TEXT NOT NULL,
  order_id    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS security_audit (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_id   TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let pool = null;
const orderId = () => `402-${1000000 + crypto.randomInt(9000000)}-${1000000 + crypto.randomInt(9000000)}`;

const state = (row) => row.state;
const asOrder = (row) => ({
  _id: row.id,
  customerId: row.customer_id,
  state: row.state,
  items: row.items,
  address: row.address,
  pricing: row.pricing,
  paymentScenario: row.payment_scenario,
  paymentAuthorized: row.payment_authorized,
  reservationExpiresAt: row.reservation_expires_at,
  cancelReason: row.cancel_reason,
  history: row.history || [],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

async function transitionInTxn(client, row, to, note) {
  if (!canTransition(ORDER, row.state, to)) {
    logger.warn('illegal order transition suppressed', { orderId: row.id, from: row.state, to });
    return false;
  }
  const from = row.state;
  const history = [...(row.history || []), { from, to, at: new Date().toISOString(), note }];
  await client.query('UPDATE orders SET state = $1, updated_at = now(), history = $2 WHERE id = $3', [to, JSON.stringify(history), row.id]);
  row.state = to;
  row.updated_at = new Date();
  row.history = history;
  return true;
}

async function cancelOrder(orderId, reason, correlationId, note) {
  const r = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  const row = r.rows[0];
  if (!row) return;
  if (['CANCELLED', 'PAYMENT_FAILED', 'EXPIRED'].includes(row.state)) return;
  const target = reason === 'PAYMENT_FAILED' ? 'PAYMENT_FAILED' : reason === 'EXPIRED' ? 'EXPIRED' : 'CANCELLED';
  await withTxn(pool, async (client) => {
    const cur = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const fresh = cur.rows[0];
    if (!fresh || !canTransition(ORDER, fresh.state, target)) return;
    const from = fresh.state;
    const history = [...(fresh.history || []), { from, to: target, at: new Date().toISOString(), note: note || reason }];
    await client.query('UPDATE orders SET state = $1, cancel_reason = $2, updated_at = now(), history = $3 WHERE id = $4', [target, reason, JSON.stringify(history), orderId]);
    await addOutbox(client, {
      eventType: 'OrderCancelled.v1', producer: 'order', aggregateId: orderId, correlationId,
      payload: { orderId, customerId: fresh.customer_id, reason },
    });
  });
}

const checkoutSchema = z.object({
  addressId: z.string().min(1),
  paymentScenario: z.enum(['success', 'failure', 'async', 'timeout']).default('success'),
});

app.post('/v1/checkout', requireUser, asyncH(async (req, res) => {
  const idemKeyHeader = req.header('idempotency-key');
  if (!idemKeyHeader || idemKeyHeader.length < 8 || idemKeyHeader.length > 128) {
    throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header of 8-128 chars is required');
  }
  const body = validate(checkoutSchema, req.body);
  const hash = hashBody(body);
  const idemId = `${req.user.id}:${idemKeyHeader}`;

  // Idempotency replay
  const existing = await pool.query('SELECT * FROM idempotency_keys WHERE key = $1', [idemId]);
  if (existing.rows.length) {
    if (existing.rows[0].hash !== hash) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Same Idempotency-Key was used with a different body');
    const o = await pool.query('SELECT * FROM orders WHERE id = $1', [existing.rows[0].order_id]);
    res.setHeader('Idempotent-Replayed', 'true');
    return sendOrderResponse(res, o.rows[0] ? asOrder(o.rows[0]) : null, true);
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
  const orderIdNew = orderId();
  const historySeed = JSON.stringify([{ from: null, to: 'PENDING_VALIDATION', at: new Date().toISOString(), note: 'Checkout started' }]);
  await pool.query(
    `INSERT INTO orders (id, customer_id, state, items, address, pricing, payment_scenario, history)
     VALUES ($1,$2,'PENDING_VALIDATION',$3,$4,$5,$6,$7)`,
    [orderIdNew, req.user.id, JSON.stringify(items), JSON.stringify(address), JSON.stringify(pricing), body.paymentScenario, historySeed]);

  // Persist idempotency key
  try {
    await pool.query('INSERT INTO idempotency_keys (key, hash, order_id) VALUES ($1,$2,$3)', [idemId, hash, orderIdNew]);
  } catch (e) {
    if (e.code === '23505') {
      const winner = await pool.query('SELECT * FROM idempotency_keys WHERE key = $1', [idemId]);
      const w = winner.rows[0];
      const wo = w && (await pool.query('SELECT * FROM orders WHERE id = $1', [w.order_id])).rows[0];
      res.setHeader('Idempotent-Replayed', 'true');
      return sendOrderResponse(res, wo ? asOrder(wo) : null, true);
    }
    throw e;
  }

  // 5. Reserve stock
  const reserveRes = await callService(config.services.inventory, '/internal/reservations', {
    method: 'POST', body: { orderId: orderIdNew, items: items.map((i) => ({ sku: i.sku, quantity: i.quantity })), ttlSeconds: config.reservationTtlSeconds },
    cid: req.correlationId, timeoutMs: 8000, retries: 0,
  });
  if (!reserveRes.ok) {
    const unavailable = reserveRes.data?.error?.unavailable || reserveRes.data?.unavailable;
    await cancelOrder(orderIdNew, 'OUT_OF_STOCK', req.correlationId, 'Insufficient stock for: ' + JSON.stringify(unavailable || []));
    const o = await pool.query('SELECT * FROM orders WHERE id = $1', [orderIdNew]);
    return res.status(409).json({ error: { code: 'OUT_OF_STOCK', message: 'Some items are out of stock', unavailable, orderId: orderIdNew, correlationId: req.correlationId }, order: o.rows[0] ? asOrder(o.rows[0]) : null });
  }
  const reservationExpiresAt = reserveRes.data.reservationExpiresAt;
  await withTxn(pool, async (client) => {
    const cur = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderIdNew]);
    const row = cur.rows[0];
    if (row) {
      await transitionInTxn(client, row, 'INVENTORY_RESERVED', 'Stock reserved');
      if (reservationExpiresAt) await client.query('UPDATE orders SET reservation_expires_at = $1 WHERE id = $2', [reservationExpiresAt, orderIdNew]);
    }
  });
  await withTxn(pool, async (client) => {
    const cur = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderIdNew]);
    const row = cur.rows[0];
    if (row) await transitionInTxn(client, row, 'PAYMENT_PENDING', 'Awaiting payment authorization');
  });

  // 6. Authorize payment
  const payRes = await callService(config.services.payment, '/internal/payments/authorize', {
    method: 'POST', body: { orderId: orderIdNew, amount: pricing.total, currency: 'INR', scenario: body.paymentScenario, customerId: req.user.id },
    cid: req.correlationId, timeoutMs: body.paymentScenario === 'timeout' ? 12000 : 6000, retries: 0,
  });
  const payStatus = payRes.data?.status;

  if (payStatus === 'AUTHORIZED') {
    const confirmed = await confirmOrder(orderIdNew, req.correlationId);
    return sendOrderResponse(res, confirmed ? asOrder(confirmed) : null, false, 201);
  }
  if (payStatus === 'FAILED') {
    await cancelOrder(orderIdNew, 'PAYMENT_FAILED', req.correlationId, 'Payment declined by provider');
    const o = await pool.query('SELECT * FROM orders WHERE id = $1', [orderIdNew]);
    return res.status(402).json({ error: { code: 'PAYMENT_FAILED', message: 'Payment was declined', orderId: orderIdNew, correlationId: req.correlationId }, order: o.rows[0] ? asOrder(o.rows[0]) : null });
  }
  // Async/timeout: 202 pending; webhook/reconciler/sweeper will finish
  const o = await pool.query('SELECT * FROM orders WHERE id = $1', [orderIdNew]);
  return res.status(202).json({ order: o.rows[0] ? asOrder(o.rows[0]) : null, pending: true, correlationId: req.correlationId });
}));

async function confirmOrder(orderId, correlationId) {
  const commitRes = await callService(config.services.inventory, `/internal/reservations/${orderId}/commit`, { method: 'POST', body: {}, cid: correlationId, timeoutMs: 8000, retries: 2 });
  if (!commitRes.ok) {
    logger.warn('reservation commit failed; sweeper will retry', { orderId, status: commitRes.status });
    const o = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    return o.rows[0] || null;
  }
  let justConfirmed = false;
  await withTxn(pool, async (client) => {
    const cur = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const row = cur.rows[0];
    if (!row || row.state === 'CONFIRMED') return;
    const ok = await transitionInTxn(client, row, 'CONFIRMED', 'Payment authorized; reservation committed');
    if (!ok) return;
    await client.query('UPDATE orders SET payment_authorized = true WHERE id = $1', [orderId]);
    await addOutbox(client, {
      eventType: 'OrderConfirmed.v1', producer: 'order', aggregateId: orderId, correlationId,
      payload: { orderId, customerId: row.customer_id, total: row.pricing.total, currency: row.pricing.currency, items: row.items },
    });
    justConfirmed = true;
  });
  if (justConfirmed) {
    const o = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    const customerId = o.rows[0]?.customer_id;
    if (customerId) {
      callService(config.services.cart, `/internal/carts/${customerId}`, { method: 'DELETE', timeoutMs: 3000, retries: 0 })
        .then(() => logger.info('cart cleared for order', { orderId }))
        .catch((e) => logger.warn('cart clear failed', { orderId, err: e.message }));
    }
  }
  const o = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  return o.rows[0] || null;
}

function sendOrderResponse(res, order, replayed, status) {
  if (!order) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
  const st = order.state;
  if (status) return res.status(status).json({ order, ...(replayed ? { replayed: true } : {}) });
  if (st === 'CONFIRMED') return res.status(201).json({ order, ...(replayed ? { replayed: true } : {}) });
  if (['CANCELLED'].includes(st)) return res.status(409).json({ order, ...(replayed ? { replayed: true } : {}) });
  if (st === 'PAYMENT_FAILED') return res.status(402).json({ order, ...(replayed ? { replayed: true } : {}) });
  if (st === 'EXPIRED') return res.status(409).json({ order, ...(replayed ? { replayed: true } : {}) });
  return res.status(202).json({ order, pending: true, ...(replayed ? { replayed: true } : {}) });
}

app.get('/v1/orders', requireUser, asyncH(async (req, res) => {
  const r = await pool.query('SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  res.json({ orders: r.rows.map(asOrder) });
}));

app.get('/v1/orders/:id', requireUser, asyncH(async (req, res) => {
  const r = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  const row = r.rows[0];
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
  const isOwner = row.customer_id === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) {
    await pool.query('INSERT INTO security_audit (user_id, action, target_id) VALUES ($1,$2,$3)', [req.user.id, 'ORDER_READ_FORBIDDEN', row.id]);
    throw new HttpError(404, 'NOT_FOUND', 'Order not found');
  }
  res.json({ order: asOrder(row) });
}));

app.get('/v1/admin/orders', requireAdmin, asyncH(async (req, res) => {
  const st = req.query.state ? String(req.query.state) : null;
  const r = await pool.query(st ? 'SELECT * FROM orders WHERE state = $1 ORDER BY created_at DESC LIMIT 100' : 'SELECT * FROM orders ORDER BY created_at DESC LIMIT 100', st ? [st] : []);
  res.json({ orders: r.rows.map(asOrder) });
}));

// Sweeper: every 15s retry authorized-but-unconfirmed, cancel stale PENDING_VALIDATION/PAYMENT_PENDING
setInterval(async () => {
  try {
    const authUnconfirmed = await pool.query("SELECT * FROM orders WHERE state = 'PAYMENT_PENDING' AND payment_authorized = true LIMIT 20");
    for (const row of authUnconfirmed.rows) await confirmOrder(row.id);
    const stale = await pool.query("SELECT id FROM orders WHERE state = 'PENDING_VALIDATION' AND created_at < now() - interval '120 seconds' LIMIT 20");
    for (const row of stale.rows) await cancelOrder(row.id, 'EXPIRED', undefined, 'Checkout abandoned for over 120s');
    const pendingLong = await pool.query("SELECT id FROM orders WHERE state = 'PAYMENT_PENDING' AND created_at < now() - interval '1 hour' LIMIT 20");
    for (const row of pendingLong.rows) await cancelOrder(row.id, 'EXPIRED', undefined, 'Payment pending too long');
  } catch (err) {
    logger.warn('sweeper error', { err: err.message });
  }
}, 15000).unref();

async function handleReservationExpired(envl) {
  const orderId = (envl.payload || {}).orderId;
  if (!orderId) return;
  await cancelOrder(orderId, 'EXPIRED', envl.correlation_id, 'Reservation expired');
}

(async () => {
  pool = await connectDb('bazaarly_orders');
  await pool.query(SCHEMA);
  await ensureEventTables(pool);
  await amqpConnect().catch(() => {});
  startOutboxRelay('order', pool);
  await consume('order.payment-events', async (envl) => {
    const p = envl.payload || {};
    if (envl.event_type === 'PaymentAuthorized.v1') {
      await pool.query('UPDATE orders SET payment_authorized = true, updated_at = now() WHERE id = $1 AND payment_authorized = false', [p.orderId]);
      await confirmOrder(p.orderId, envl.correlation_id);
    } else if (envl.event_type === 'PaymentFailed.v1') {
      await cancelOrder(p.orderId, 'PAYMENT_FAILED', envl.correlation_id, 'Payment failed');
    }
  }, pool);
  await consume('order.inventory-events', async (envl) => {
    const p = envl.payload || {};
    if (envl.event_type === 'ReservationExpired.v1') await handleReservationExpired(envl);
  }, pool);
  await consume('order.tracking', async (envl) => {
    const p = envl.payload || {};
    const map = { LABELLED: 'FULFILLING', IN_TRANSIT: 'FULFILLING', OUT_FOR_DELIVERY: 'SHIPPED', DELIVERED: 'DELIVERED', CREATED: null };
    const target = map[p.status];
    if (!target) return;
    const r = await pool.query('SELECT * FROM orders WHERE id = $1', [p.orderId]);
    const row = r.rows[0];
    if (!row || !canTransition(ORDER, row.state, target)) return;
    const from = row.state;
    const history = [...(row.history || []), { from, to: target, at: new Date().toISOString(), note: `Shipment status: ${p.status}` }];
    await pool.query('UPDATE orders SET state = $1, updated_at = now(), history = $2 WHERE id = $3', [target, JSON.stringify(history), row.id]);
  }, pool);
  finish(app);
  listen(app, PORT, 'order');
})().catch((err) => { logger.error('order failed to start', { err: err.message }); process.exit(1); });
