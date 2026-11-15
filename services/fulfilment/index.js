'use strict';
// Fulfilment service: shipments created from OrderConfirmed.v1, admin-driven milestone
// updates with guarded transitions, append-only event log, TrackingUpdated.v1 outbox.
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const crypto = require('crypto');
const config = require('../../shared/config');
const logger = require('../../shared/logger');
const { createApp, finish, listen, asyncH, validate, requireUser, requireAdmin, HttpError } = require('../../shared/http');
const { connectMongo, mongoose, withTxn } = require('../../shared/db');
const { addOutbox, consume, startOutboxRelay, amqpConnect } = require('../../shared/events');

const app = createApp('fulfilment');
const PORT = parseInt(process.env.PORT || '4009', 10);

const shipmentSchema = new mongoose.Schema({
  _id: String,             // "SHP-<orderId>"
  orderId: { type: String, unique: true, index: true },
  customerId: String,
  state: { type: String, enum: ['CREATED', 'LABELLED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION', 'RETURNED'], default: 'CREATED', index: true },
  events: [{ eventId: String, status: String, note: String, at: { type: Date, default: Date.now } }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { collection: 'shipments', versionKey: false, _id: false });
const Shipment = mongoose.model('Shipment', shipmentSchema);

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
  const _id = `SHP-${orderId}`;
  const existing = await Shipment.findById(_id);
  if (existing) return existing;
  return Shipment.create({ _id, orderId, customerId, state: 'CREATED', events: [{ eventId: uuid(), status: 'CREATED', note: 'Shipment created', at: new Date() }] });
}

// Admin: add tracking event
const eventSchema = z.object({
  status: z.enum(['LABELLED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION', 'RETURNED']),
  note: z.string().max(500).optional().default(''),
  eventId: z.string().min(4).max(100).optional(),
});

app.post('/v1/admin/shipments/:orderId/events', requireAdmin, asyncH(async (req, res) => {
  const { status, note, eventId } = validate(eventSchema, req.body);
  const orderId = req.params.orderId;
  const evtId = eventId || uuid();

  const shipment = await withTxn(async (session) => {
    const s = await Shipment.findOne({ orderId }).session(session);
    if (!s) throw new (require('../../shared/db').TxnAbort)({ notFound: true });
    // Dedupe by eventId (idempotent retries from admin UI / network)
    if ((s.events || []).some((e) => e.eventId === evtId)) return { shipment: s, deduped: true };
    if (!(SHIPMENT_FSM[s.state] || []).includes(status)) {
      throw new (require('../../shared/db').TxnAbort)({ illegal: true, from: s.state, to: status });
    }
    s.state = status;
    s.updatedAt = new Date();
    s.events = [...s.events, { eventId: evtId, status, note, at: new Date() }];
    await s.save({ session });
    await addOutbox(session, {
      eventType: 'TrackingUpdated.v1', producer: 'fulfilment', aggregateId: orderId, correlationId: req.correlationId,
      payload: { orderId, customerId: s.customerId, status, note, eventId: evtId },
    });
    return { shipment: s };
  });

  if (shipment.aborted) {
    if (shipment.result?.notFound) throw new HttpError(404, 'NOT_FOUND', 'Shipment not found for that order');
    throw new HttpError(409, 'ILLEGAL_TRANSITION', `Cannot move shipment ${shipment.result.from} -> ${shipment.result.to}`);
  }
  res.status(shipment.result.deduped ? 200 : 201).json({ shipment: shipment.result.shipment, deduped: !!shipment.result.deduped });
}));

// GET /v1/orders/:id/tracking — owner only (fulfilment doesn't know order ownership,
// so the gateway passes the principal; owner check is enforced here via customerId).
app.get('/v1/orders/:id/tracking', requireUser, asyncH(async (req, res) => {
  const orderId = req.params.id;
  const s = await Shipment.findOne({ orderId }).lean();
  if (!s) throw new HttpError(404, 'NOT_FOUND', 'No shipment for that order yet');
  if (req.user.role !== 'admin' && s.customerId !== req.user.id) {
    throw new HttpError(404, 'NOT_FOUND', 'Shipment not found'); // don't leak existence
  }
  res.json({ tracking: { orderId: s.orderId, state: s.state, events: s.events } });
}));

app.get('/v1/admin/shipments', requireAdmin, asyncH(async (_req, res) => {
  const shipments = await Shipment.find().sort({ createdAt: -1 }).limit(100).lean();
  res.json({ shipments });
}));

(async () => {
  await connectMongo('fulfilment');
  await amqpConnect().catch(() => {});
  startOutboxRelay('fulfilment');
  await consume('fulfilment.order-confirmed', async (envl) => {
    const p = envl.payload || {};
    if (p.orderId) await ensureShipment(p.orderId, p.customerId);
  });
  finish(app);
  listen(app, PORT, 'fulfilment');
})().catch((err) => { logger.error('fulfilment failed to start', { err: err.message }); process.exit(1); });
