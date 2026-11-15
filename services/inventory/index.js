'use strict';
// Inventory service: stock balances, reservations (all-or-nothing saga step),
// availability, admin adjustments with audit trail.
const { z } = require('zod');
const config = require('../../shared/config');
const logger = require('../../shared/logger');
const { createApp, finish, listen, asyncH, validate, requireAdmin, HttpError } = require('../../shared/http');
const { connectMongo, mongoose, withTxn, TxnAbort } = require('../../shared/db');
const { addOutbox, consume, startOutboxRelay, amqpConnect } = require('../../shared/events');
const { callService } = require('../../shared/clients');
const { LOW_STOCK_SKU, OUT_OF_STOCK_SKU } = require('../catalog/seed');

const app = createApp('inventory');
const PORT = parseInt(process.env.PORT || '4004', 10);

const balanceSchema = new mongoose.Schema({
  sku: { type: String, unique: true, index: true },
  location: { type: String, default: 'MAIN' },
  onHand: { type: Number, default: 0, min: 0 },
  reserved: { type: Number, default: 0, min: 0 },
  version: { type: Number, default: 1 },
}, { collection: 'balances', versionKey: false });
const reservationSchema = new mongoose.Schema({
  _id: String,             // uuid
  orderId: { type: String, index: true },
  sku: String,
  quantity: Number,
  state: { type: String, enum: ['ACTIVE', 'COMMITTED', 'RELEASED', 'EXPIRED'], default: 'ACTIVE', index: true },
  expiresAt: { type: Date, index: true },
  createdAt: { type: Date, default: Date.now },
}, { collection: 'reservations', versionKey: false, _id: false });
reservationSchema.index({ orderId: 1, sku: 1 }, { unique: true });
const adjSchema = new mongoose.Schema({
  sku: String, delta: Number, reason: String, adminId: String, at: { type: Date, default: Date.now },
}, { collection: 'inventory_adjustments', versionKey: false });

const Balance = mongoose.model('InventoryBalance', balanceSchema);
const Reservation = mongoose.model('InventoryReservation', reservationSchema);
const Adjustment = mongoose.model('InventoryAdjustment', adjSchema);

async function addBalanceIfMissing(sku, initialStock) {
  await Balance.findOneAndUpdate({ sku }, { $setOnInsert: { sku, location: 'MAIN', onHand: initialStock, reserved: 0, version: 1 } }, { upsert: true });
}

// POST /internal/reservations { orderId, items: [{sku, quantity}], ttlSeconds }
const reserveSchema = z.object({
  orderId: z.string().min(4).max(64),
  items: z.array(z.object({ sku: z.string().min(1), quantity: z.number().int().min(1).max(10) })).min(1).max(50),
  ttlSeconds: z.number().int().min(30).max(3600).optional(),
});

app.post('/internal/reservations', asyncH(async (req, res) => {
  const { orderId, items, ttlSeconds } = validate(reserveSchema, req.body);
  const ttl = ttlSeconds || config.reservationTtlSeconds;

  // Idempotent per orderId: if any ACTIVE/COMMITTED reservation exists for this order, return it.
  const existing = await Reservation.find({ orderId }).lean();
  if (existing.length) {
    const active = existing.filter((r) => r.state === 'ACTIVE' || r.state === 'COMMITTED');
    if (active.length === items.length) {
      return res.status(200).json({ reservationId: active[0]._id, orderId, status: 'RESERVED', reservationExpiresAt: active[0].expiresAt, replayed: true });
    }
  }

  const expiresAt = new Date(Date.now() + ttl * 1000);
  const result = await withTxn(async (session) => {
    // Guarded decrement per item; all-or-nothing.
    const reserved = [];
    for (const item of items) {
      const b = await Balance.findOneAndUpdate(
        { sku: item.sku, $expr: { $gte: [{ $subtract: ['$onHand', '$reserved'] }, item.quantity] } },
        { $inc: { reserved: item.quantity, version: 1 } },
        { new: true, session }
      );
      if (!b) {
        // Roll back earlier decrements by aborting the transaction entirely.
        throw new TxnAbort({ unavailable: [item.sku] });
      }
      reserved.push(b);
    }
    const docs = items.map((item) => ({ _id: require('uuid').v4(), orderId, sku: item.sku, quantity: item.quantity, state: 'ACTIVE', expiresAt }));
    await Reservation.create(docs, { session, ordered: true });
    await addOutbox(session, {
      eventType: 'InventoryReserved.v1', producer: 'inventory', aggregateId: orderId, correlationId: req.correlationId,
      payload: { orderId, items, reservationExpiresAt: expiresAt.toISOString() },
    });
    return docs;
  });

  if (result.aborted) {
    return res.status(409).json({ error: { code: 'INSUFFICIENT_STOCK', message: 'Some items are unavailable', unavailable: result.result.unavailable } });
  }
  res.status(201).json({ reservationId: result.result[0]._id, orderId, status: 'RESERVED', reservationExpiresAt: expiresAt.toISOString() });
}));

// POST /internal/reservations/:orderId/commit
app.post('/internal/reservations/:orderId/commit', asyncH(async (req, res) => {
  const orderId = req.params.orderId;
  const result = await withTxn(async (session) => {
    const reservations = await Reservation.find({ orderId, state: 'ACTIVE' }).session(session);
    if (!reservations.length) {
      const any = await Reservation.find({ orderId }).session(session);
      // Idempotent replay: already committed
      if (any.length && any.every((r) => r.state === 'COMMITTED')) return { alreadyCommitted: true };
      throw new TxnAbort({ conflict: true, states: any.map((r) => r.state) });
    }
    for (const r of reservations) {
      await Balance.updateOne({ sku: r.sku }, { $inc: { onHand: -r.quantity, reserved: -r.quantity, version: 1 } }, { session });
      r.state = 'COMMITTED';
      await r.save({ session });
    }
    return { committed: reservations.length };
  });
  if (result.aborted) {
    return res.status(409).json({ error: { code: 'RESERVATION_NOT_ACTIVE', message: 'Reservation released or expired; cannot commit', states: result.result.states } });
  }
  res.json({ orderId, status: 'COMMITTED', ...(result.result.alreadyCommitted ? { replayed: true } : {}) });
}));

// POST /internal/reservations/:orderId/release
app.post('/internal/reservations/:orderId/release', asyncH(async (req, res) => {
  const orderId = req.params.orderId;
  const reason = (req.body && req.body.reason) || 'RELEASED';
  const result = await withTxn(async (session) => {
    const reservations = await Reservation.find({ orderId, state: 'ACTIVE' }).session(session);
    for (const r of reservations) {
      await Balance.updateOne({ sku: r.sku }, { $inc: { reserved: -r.quantity, version: 1 } }, { session });
      r.state = 'RELEASED';
      await r.save({ session });
    }
    return { released: reservations.length };
  });
  logger.info('reservations released', { orderId, reason });
  res.json({ orderId, status: 'RELEASED', released: result.result?.released || 0 });
}));

// GET /v1/availability?skus=a,b,c
app.get('/v1/availability', asyncH(async (req, res) => {
  const skus = String(req.query.skus || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
  if (!skus.length) throw new HttpError(400, 'BAD_QUERY', 'skus query param required');
  const balances = await Balance.find({ sku: { $in: skus } }).lean();
  const map = new Map(balances.map((b) => [b.sku, b.onHand - b.reserved]));
  const result = {};
  for (const sku of skus) {
    const avail = map.get(sku);
    if (avail == null) { result[sku] = { status: 'OUT_OF_STOCK' }; continue; }
    if (avail <= 0) result[sku] = { status: 'OUT_OF_STOCK' };
    else if (avail <= 5) result[sku] = { status: 'LOW', count: avail };
    else result[sku] = { status: 'IN_STOCK' };
  }
  res.json({ availability: result });
}));

// ---- Admin -------------------------------------------------------------------
const adjustSchema = z.object({
  sku: z.string().min(1), delta: z.number().int().refine((n) => n !== 0, 'delta must be non-zero'),
  reason: z.string().min(3).max(500), confirmLarge: z.boolean().optional(),
});

app.post('/v1/admin/inventory-adjustments', requireAdmin, asyncH(async (req, res) => {
  const { sku, delta, reason, confirmLarge } = validate(adjustSchema, req.body);
  if (Math.abs(delta) > 100 && confirmLarge !== true) {
    throw new HttpError(400, 'CONFIRM_LARGE_REQUIRED', '|delta| > 100 requires confirmLarge=true');
  }
  const result = await withTxn(async (session) => {
    const b = await Balance.findOneAndUpdate({ sku }, [{ $set: { onHand: { $max: [0, { $add: ['$onHand', delta] }] }, version: { $add: ['$version', 1] } } }], { new: true, session });
    if (!b) throw new TxnAbort({ notFound: true });
    await Adjustment.create([{ sku, delta, reason, adminId: req.user.id }], { session });
    return b;
  });
  if (result.aborted) throw new HttpError(404, 'NOT_FOUND', 'Unknown SKU');
  res.json({ balance: result.result });
}));

app.get('/v1/admin/inventory', requireAdmin, asyncH(async (_req, res) => {
  const balances = await Balance.find().sort({ sku: 1 }).lean();
  res.json({ inventory: balances.map((b) => ({ sku: b.sku, location: b.location, onHand: b.onHand, reserved: b.reserved, available: b.onHand - b.reserved, version: b.version })) });
}));

app.get('/v1/admin/inventory-adjustments', requireAdmin, asyncH(async (_req, res) => {
  const rows = await Adjustment.find().sort({ at: -1 }).limit(100).lean();
  res.json({ adjustments: rows });
}));

// Expiry worker: release ACTIVE holds past expiry every 15s
function startExpiryWorker() {
  setInterval(async () => {
    try {
      const expired = await Reservation.find({ state: 'ACTIVE', expiresAt: { $lt: new Date() } }).limit(100);
      for (const r of expired) {
        await withTxn(async (session) => {
          const fresh = await Reservation.findOneAndUpdate({ _id: r._id, state: 'ACTIVE' }, { $set: { state: 'EXPIRED' } }, { new: true, session });
          if (!fresh) return; // someone else handled it
          await Balance.updateOne({ sku: r.sku }, { $inc: { reserved: -r.quantity, version: 1 } }, { session });
          await addOutbox(session, {
            eventType: 'ReservationExpired.v1', producer: 'inventory', aggregateId: r.orderId,
            payload: { orderId: r.orderId, sku: r.sku, quantity: r.quantity },
          });
        });
      }
    } catch (err) {
      logger.warn('expiry worker error', { err: err.message });
    }
  }, 15000).unref();
}

// Seed balances from catalog (default 50; low stock sku -> 5; out of stock sku -> 0)
async function seedBalances() {
  const count = await Balance.countDocuments();
  if (count > 0) return;
  const res = await callService(config.services.catalog, '/internal/products?all=1', { timeoutMs: 10000, retries: 5 });
  if (!res.ok) { logger.warn('could not fetch catalog for inventory seed'); return; }
  for (const p of res.data.items || []) {
    let stock = 50;
    if (p.sku === LOW_STOCK_SKU) stock = 5;
    if (p.sku === OUT_OF_STOCK_SKU) stock = 0;
    await addBalanceIfMissing(p.sku, stock);
  }
  logger.info('seeded inventory balances', { count: (res.data.items || []).length });
}

(async () => {
  await connectMongo('inventory');
  await amqpConnect().catch(() => {});
  startOutboxRelay('inventory');
  await consume('inventory.product-changed', async (envl) => {
    const p = envl.payload || {};
    if (p.sku) await addBalanceIfMissing(p.sku, p.initialStock != null ? p.initialStock : 50);
  });
  await consume('inventory.order-cancelled', async (envl) => {
    const orderId = (envl.payload || {}).orderId;
    if (!orderId) return;
    const reservations = await Reservation.find({ orderId, state: 'ACTIVE' });
    for (const r of reservations) {
      await withTxn(async (session) => {
        const fresh = await Reservation.findOneAndUpdate({ _id: r._id, state: 'ACTIVE' }, { $set: { state: 'RELEASED' } }, { new: true, session });
        if (fresh) await Balance.updateOne({ sku: r.sku }, { $inc: { reserved: -r.quantity, version: 1 } }, { session });
      });
    }
  });
  await seedBalances();
  startExpiryWorker();
  finish(app);
  listen(app, PORT, 'inventory');
})().catch((err) => { logger.error('inventory failed to start', { err: err.message }); process.exit(1); });
