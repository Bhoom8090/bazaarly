'use strict';
// Inventory service: stock balances, reservations (all-or-nothing saga step),
// availability, admin adjustments with audit trail.
require('../../shared/telemetry');
const { z } = require('zod');
const { v4: uuid } = require('uuid');
const config = require('../../shared/config');
const logger = require('../../shared/logger');
const { createApp, finish, listen, asyncH, validate, requireAdmin, HttpError } = require('../../shared/http');
const { connectDb, withTxn, TxnAbort, ensureEventTables } = require('../../shared/db');
const { addOutbox, consume, startOutboxRelay, amqpConnect } = require('../../shared/events');
const { callService } = require('../../shared/clients');
const { LOW_STOCK_SKU, OUT_OF_STOCK_SKU } = require('../catalog/seed');

const app = createApp('inventory');
const PORT = parseInt(process.env.PORT || '4004', 10);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS balances (
  sku        TEXT PRIMARY KEY,
  location   TEXT NOT NULL DEFAULT 'MAIN',
  on_hand    BIGINT NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved   BIGINT NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  version    INT NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS reservations (
  reservation_id  TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL,
  sku             TEXT NOT NULL,
  quantity        INT NOT NULL CHECK (quantity >= 1 AND quantity <= 10),
  state           TEXT NOT NULL DEFAULT 'ACTIVE',
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, sku)
);
CREATE INDEX IF NOT EXISTS reservations_active_idx ON reservations (state, expires_at) WHERE state = 'ACTIVE';
CREATE TABLE IF NOT EXISTS inventory_adjustments (
  id          BIGSERIAL PRIMARY KEY,
  sku         TEXT NOT NULL,
  delta       BIGINT NOT NULL,
  reason      TEXT NOT NULL,
  admin_id    TEXT NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let pool = null;

async function addBalanceIfMissing(sku, initialStock, client) {
  const q = client || pool;
  await q.query(
    'INSERT INTO balances (sku, location, on_hand, reserved, version) VALUES ($1,$2,$3,$4,1) ON CONFLICT (sku) DO NOTHING',
    [sku, 'MAIN', initialStock, 0]);
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

  // Idempotent per orderId
  const existing = await pool.query('SELECT * FROM reservations WHERE order_id = $1', [orderId]);
  if (existing.rows.length) {
    const active = existing.rows.filter((r) => r.state === 'ACTIVE' || r.state === 'COMMITTED');
    if (active.length === items.length) {
      return res.status(200).json({ reservationId: active[0].reservation_id, orderId, status: 'RESERVED', reservationExpiresAt: active[0].expires_at, replayed: true });
    }
  }

  const expiresAt = new Date(Date.now() + ttl * 1000);
  const result = await withTxn(pool, async (client) => {
    const docs = [];
    for (const item of items) {
      // Guarded decrement: only succeeds if enough is available
      const upd = await client.query(
        'UPDATE balances SET reserved = reserved + $2, version = version + 1 WHERE sku = $1 AND on_hand - reserved >= $2 RETURNING sku',
        [item.sku, item.quantity]);
      if (!upd.rowCount) {
        throw new TxnAbort({ unavailable: [item.sku] });
      }
      const reservationId = uuid();
      await client.query(
        'INSERT INTO reservations (reservation_id, order_id, sku, quantity, state, expires_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [reservationId, orderId, item.sku, item.quantity, 'ACTIVE', expiresAt]);
      docs.push({ reservation_id: reservationId, sku: item.sku });
    }
    await addOutbox(client, {
      eventType: 'InventoryReserved.v1', producer: 'inventory', aggregateId: orderId, correlationId: req.correlationId,
      payload: { orderId, items, reservationExpiresAt: expiresAt.toISOString() },
    });
    return docs;
  });

  if (result.aborted) {
    return res.status(409).json({ error: { code: 'INSUFFICIENT_STOCK', message: 'Some items are unavailable', unavailable: result.result.unavailable } });
  }
  res.status(201).json({ reservationId: result.result[0].reservation_id, orderId, status: 'RESERVED', reservationExpiresAt: expiresAt.toISOString() });
}));

// POST /internal/reservations/:orderId/commit
app.post('/internal/reservations/:orderId/commit', asyncH(async (req, res) => {
  const orderId = req.params.orderId;
  const result = await withTxn(pool, async (client) => {
    const reservations = await client.query('SELECT * FROM reservations WHERE order_id = $1', [orderId]);
    const all = reservations.rows;
    const active = all.filter((r) => r.state === 'ACTIVE');
    if (!active.length) {
      if (all.length && all.every((r) => r.state === 'COMMITTED')) return { alreadyCommitted: true };
      throw new TxnAbort({ conflict: true, states: all.map((r) => r.state) });
    }
    for (const r of active) {
      await client.query('UPDATE balances SET on_hand = on_hand - $2, reserved = reserved - $2, version = version + 1 WHERE sku = $1', [r.sku, r.quantity]);
      await client.query("UPDATE reservations SET state = 'COMMITTED' WHERE reservation_id = $1 AND state = 'ACTIVE'", [r.reservation_id]);
    }
    return { committed: active.length };
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
  const result = await withTxn(pool, async (client) => {
    const reservations = await client.query('SELECT * FROM reservations WHERE order_id = $1 AND state = $2', [orderId, 'ACTIVE']);
    let released = 0;
    for (const r of reservations.rows) {
      await client.query('UPDATE balances SET reserved = reserved - $2, version = version + 1 WHERE sku = $1', [r.sku, r.quantity]);
      await client.query("UPDATE reservations SET state = 'RELEASED' WHERE reservation_id = $1 AND state = 'ACTIVE'", [r.reservation_id]);
      released++;
    }
    return { released };
  });
  logger.info('reservations released', { orderId, reason });
  res.json({ orderId, status: 'RELEASED', released: result.result?.released || 0 });
}));

// GET /v1/availability?skus=a,b,c
app.get('/v1/availability', asyncH(async (req, res) => {
  const skus = String(req.query.skus || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
  if (!skus.length) throw new HttpError(400, 'BAD_QUERY', 'skus query param required');
  const r = await pool.query('SELECT sku, on_hand, reserved FROM balances WHERE sku = ANY($1)', [skus]);
  const map = new Map(r.rows.map((b) => [b.sku, Number(b.on_hand) - Number(b.reserved)]));
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

// ---- Admin ------------------------------------------------------------------
const adjustSchema = z.object({
  sku: z.string().min(1), delta: z.number().int().refine((n) => n !== 0, 'delta must be non-zero'),
  reason: z.string().min(3).max(500), confirmLarge: z.boolean().optional(),
});

app.post('/v1/admin/inventory-adjustments', requireAdmin, asyncH(async (req, res) => {
  const { sku, delta, reason, confirmLarge } = validate(adjustSchema, req.body);
  if (Math.abs(delta) > 100 && confirmLarge !== true) {
    throw new HttpError(400, 'CONFIRM_LARGE_REQUIRED', '|delta| > 100 requires confirmLarge=true');
  }
  const result = await withTxn(pool, async (client) => {
    const upd = await client.query(
      'UPDATE balances SET on_hand = GREATEST(0, on_hand + $2), version = version + 1 WHERE sku = $1 RETURNING *',
      [sku, delta]);
    if (!upd.rowCount) throw new TxnAbort({ notFound: true });
    await client.query('INSERT INTO inventory_adjustments (sku, delta, reason, admin_id) VALUES ($1,$2,$3,$4)', [sku, delta, reason, req.user.id]);
    return upd.rows[0];
  });
  if (result.aborted) throw new HttpError(404, 'NOT_FOUND', 'Unknown SKU');
  res.json({ balance: { ...result.result, available: Number(result.result.on_hand) - Number(result.result.reserved) } });
}));

app.get('/v1/admin/inventory', requireAdmin, asyncH(async (_req, res) => {
  const r = await pool.query('SELECT sku, location, on_hand, reserved, version FROM balances ORDER BY sku');
  res.json({ inventory: r.rows.map((b) => ({ sku: b.sku, location: b.location, onHand: Number(b.on_hand), reserved: Number(b.reserved), available: Number(b.on_hand) - Number(b.reserved), version: b.version })) });
}));

app.get('/v1/admin/inventory-adjustments', requireAdmin, asyncH(async (_req, res) => {
  const r = await pool.query('SELECT * FROM inventory_adjustments ORDER BY at DESC LIMIT 100');
  res.json({ adjustments: r.rows });
}));

// Expiry worker: release ACTIVE reservations past expiry every 15s
function startExpiryWorker() {
  setInterval(async () => {
    try {
      const result = await withTxn(pool, async (client) => {
        const expired = await client.query("SELECT * FROM reservations WHERE state = 'ACTIVE' AND expires_at < now() LIMIT 100 FOR UPDATE SKIP LOCKED");
        let released = 0;
        for (const r of expired.rows) {
          const upd = await client.query("UPDATE reservations SET state = 'EXPIRED' WHERE reservation_id = $1 AND state = 'ACTIVE'", [r.reservation_id]);
          if (!upd.rowCount) continue; // someone else handled it
          await client.query('UPDATE balances SET reserved = reserved - $2, version = version + 1 WHERE sku = $1', [r.sku, r.quantity]);
          await addOutbox(client, {
            eventType: 'ReservationExpired.v1', producer: 'inventory', aggregateId: r.order_id,
            payload: { orderId: r.order_id, sku: r.sku, quantity: r.quantity },
          });
          released++;
        }
        return { released };
      });
      if (result.result?.released) logger.info('released expired reservations', { count: result.result.released });
    } catch (err) {
      logger.warn('expiry worker error', { err: err.message });
    }
  }, 15000).unref();
}

// Seed from catalog (default 50; LOW_STOCK_SKU -> 5; OUT_OF_STOCK_SKU -> 0)
async function seedBalances() {
  const r = await pool.query('SELECT count(*)::int AS c FROM balances');
  if (r.rows[0].c > 0) return;
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
  pool = await connectDb('bazaarly_inventory');
  await pool.query(SCHEMA);
  await ensureEventTables(pool);
  await amqpConnect().catch(() => {});
  startOutboxRelay('inventory', pool);
  await consume('inventory.product-changed', async (envl) => {
    const p = envl.payload || {};
    if (p.sku) await addBalanceIfMissing(p.sku, p.initialStock != null ? p.initialStock : 50);
  }, pool);
  await consume('inventory.order-cancelled', async (envl) => {
    const orderId = (envl.payload || {}).orderId;
    if (!orderId) return;
    await withTxn(pool, async (client) => {
      const reservations = await client.query("SELECT * FROM reservations WHERE order_id = $1 AND state = 'ACTIVE' FOR UPDATE", [orderId]);
      for (const r of reservations.rows) {
        await client.query('UPDATE balances SET reserved = reserved - $2, version = version + 1 WHERE sku = $1', [r.sku, r.quantity]);
        await client.query("UPDATE reservations SET state = 'RELEASED' WHERE reservation_id = $1 AND state = 'ACTIVE'", [r.reservation_id]);
      }
    });
  }, pool);
  await seedBalances();
  startExpiryWorker();
  finish(app);
  listen(app, PORT, 'inventory');
})().catch((err) => { logger.error('inventory failed to start', { err: err.message }); process.exit(1); });
