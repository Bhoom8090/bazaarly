'use strict';
// Fulfilment service: shipments created from OrderConfirmed.v1, admin-driven milestones
// with guarded transitions, append-only events log, TrackingUpdated.v1 outbox.
require('../../shared/telemetry');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const config = require('../../shared/config');
const logger = require('../../shared/logger');
const { createApp, finish, listen, asyncH, validate, requireUser, requireAdmin, HttpError } = require('../../shared/http');
const { connectDb, withTxn, TxnAbort, ensureEventTables } = require('../../shared/db');
const { addOutbox, consume, startOutboxRelay, amqpConnect } = require('../../shared/events');

const app = createApp('fulfilment');
const PORT = parseInt(process.env.PORT || '4009', 10);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shipments (
  shipment_id   TEXT PRIMARY KEY,
  order_id      TEXT UNIQUE NOT NULL,
  customer_id   TEXT,
  state         TEXT NOT NULL DEFAULT 'CREATED',
  events        JSONB NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let pool = null;
const SHIPMENT_FSM = {
  CREATED: ['LABELLED', 'EXCEPTION'],
  LABELLED: ['IN_TRANSIT', 'EXCEPTION'],
  IN_TRANSIT: ['OUT_FOR_DELIVERY', 'EXCEPTION'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'EXCEPTION'],
  DELIVERED: ['RETURNED'],
  EXCEPTION: ['IN_TRANSIT', 'LABELLED', 'RETURNED'],
  RETURNED: [],
};

async function ensureShipment(orderId, customerId) {
  const id = `SHP-${orderId}`;
  const existing = await pool.query('SELECT * FROM shipments WHERE shipment_id = $1', [id]);
  if (existing.rows.length) return existing.rows[0];
  const r = await pool.query(
    "INSERT INTO shipments (shipment_id, order_id, customer_id, state, events) VALUES ($1,$2,$3,'CREATED',$4) ON CONFLICT (order_id) DO UPDATE SET shipment_id = shipments.shipment_id RETURNING *",
    [id, orderId, customerId || null, JSON.stringify([{ eventId: uuid(), status: 'CREATED', note: 'Shipment created', at: new Date().toISOString() }])]);
  return r.rows[0];
}

const eventSchema = z.object({
  status: z.enum(['LABELLED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION', 'RETURNED']),
  note: z.string().max(500).optional().default(''),
  eventId: z.string().min(4).max(100).optional(),
});

app.post('/v1/admin/shipments/:orderId/events', requireAdmin, asyncH(async (req, res) => {
  const { status, note, eventId } = validate(eventSchema, req.body);
  const orderId = req.params.orderId;
  const evtId = eventId || uuid();

  const result = await withTxn(pool, async (client) => {
    const cur = await client.query('SELECT * FROM shipments WHERE order_id = $1 FOR UPDATE', [orderId]);
    if (!cur.rows.length) throw new TxnAbort({ notFound: true });
    const s = cur.rows[0];
    const events = Array.isArray(s.events) ? s.events : [];
    if (events.some((e) => e.eventId === evtId)) return { shipment: s, deduped: true };
    if (!(SHIPMENT_FSM[s.state] || []).includes(status)) {
      throw new TxnAbort({ illegal: true, from: s.state, to: status });
    }
    events.push({ eventId: evtId, status, note, at: new Date().toISOString() });
    await client.query('UPDATE shipments SET state = $1, events = $2, updated_at = now() WHERE order_id = $3', [status, JSON.stringify(events), orderId]);
    await addOutbox(client, {
      eventType: 'TrackingUpdated.v1', producer: 'fulfilment', aggregateId: orderId, correlationId: req.correlationId,
      payload: { orderId, customerId: s.customer_id, status, note, eventId: evtId },
    });
    const updated = await client.query('SELECT * FROM shipments WHERE order_id = $1', [orderId]);
    return { shipment: updated.rows[0] };
  });

  if (result.aborted) {
    if (result.result?.notFound) throw new HttpError(404, 'NOT_FOUND', 'Shipment not found for that order');
    throw new HttpError(409, 'ILLEGAL_TRANSITION', `Cannot move shipment ${result.result.from} -> ${result.result.to}`);
  }
  res.status(result.result.deduped ? 200 : 201).json({ shipment: result.result.shipment, deduped: !!result.result.deduped });
}));

const dto = (s) => ({ _id: s.shipment_id, orderId: s.order_id, customerId: s.customer_id, state: s.state, events: s.events || [], createdAt: s.created_at, updatedAt: s.updated_at });

app.get('/v1/orders/:id/tracking', requireUser, asyncH(async (req, res) => {
  const orderId = req.params.id;
  const r = await pool.query('SELECT * FROM shipments WHERE order_id = $1', [orderId]);
  const s = r.rows[0];
  if (!s) throw new HttpError(404, 'NOT_FOUND', 'No shipment for that order yet');
  if (req.user.role !== 'admin' && s.customer_id !== req.user.id) {
    throw new HttpError(404, 'NOT_FOUND', 'Shipment not found');
  }
  res.json({ tracking: { orderId: s.order_id, state: s.state, events: s.events || [] } });
}));

app.get('/v1/admin/shipments', requireAdmin, asyncH(async (_req, res) => {
  const r = await pool.query('SELECT * FROM shipments ORDER BY created_at DESC LIMIT 100');
  res.json({ shipments: r.rows.map(dto) });
}));

(async () => {
  pool = await connectDb('bazaarly_fulfilment');
  await pool.query(SCHEMA);
  await ensureEventTables(pool);
  await amqpConnect().catch(() => {});
  startOutboxRelay('fulfilment', pool);
  await consume('fulfilment.order-confirmed', async (envl) => {
    const p = envl.payload || {};
    if (p.orderId) await ensureShipment(p.orderId, p.customerId);
  }, pool);
  finish(app);
  listen(app, PORT, 'fulfilment');
})().catch((err) => { logger.error('fulfilment failed to start', { err: err.message }); process.exit(1); });
