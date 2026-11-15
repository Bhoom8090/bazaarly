'use strict';
// Payment service: attempts (unique per order), provider adapter to the mock PSP,
// signed webhooks with dedupe, reconciler for stale attempts, capture/void driven by order events.
// NO PAN/CVV is ever stored or logged.
const { z } = require('zod');
const crypto = require('crypto');
const config = require('../../shared/config');
const logger = require('../../shared/logger');
const { createApp, finish, listen, asyncH, validate, HttpError } = require('../../shared/http');
const { connectMongo, mongoose, withTxn } = require('../../shared/db');
const { addOutbox, consume, startOutboxRelay, amqpConnect } = require('../../shared/events');
const { callService } = require('../../shared/clients');
const { verify } = require('../../shared/webhook');

const webhookPaths = ['/v1/webhooks/payments/'];
const app = createApp('payment', { rawPaths: webhookPaths });
const PORT = parseInt(process.env.PORT || '4007', 10);

const attemptSchema = new mongoose.Schema({
  _id: String,              // uuid
  orderId: { type: String, unique: true, index: true },
  idemKey: { type: String, index: true },          // "order-<orderId>"
  provider: { type: String, default: 'mockpsp' },
  providerRef: String,      // PSP payment intent id
  status: { type: String, enum: ['CREATED', 'PROCESSING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'VOIDED'], default: 'CREATED', index: true },
  amount: Number,
  currency: { type: String, default: 'INR' },
  scenario: String,
  customerId: String,
  authorizedAt: Date,
  failureCode: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { collection: 'payment_attempts', versionKey: false, _id: false });
const webhookEventSchema = new mongoose.Schema({
  _id: String,              // provider event id
  provider: String,
  type: String,
  payload: Object,
  receivedAt: { type: Date, default: Date.now },
  processed: { type: Boolean, default: false },
}, { collection: 'webhook_events', versionKey: false, _id: false });
const Attempt = mongoose.model('PaymentAttempt', attemptSchema);
const WebhookEvent = mongoose.model('PaymentWebhookEvent', webhookEventSchema);

const TRANSITIONS = {
  CREATED: ['PROCESSING', 'AUTHORIZED', 'FAILED', 'VOIDED'],
  PROCESSING: ['AUTHORIZED', 'FAILED', 'VOIDED'],
  AUTHORIZED: ['CAPTURED', 'VOIDED'],
  CAPTURED: [], FAILED: [], VOIDED: [],
};
const TERMINAL = ['CAPTURED', 'FAILED', 'VOIDED'];

function transitionGuard(from, to) {
  if (TERMINAL.includes(from)) return from === to; // terminal wins; no-op
  return (TRANSITIONS[from] || []).includes(to);
}

async function pspCall(path, { method = 'GET', body, idemKey, timeoutMs = 3000 } = {}) {
  return callService(config.services.mockPsp, path, {
    method, body, timeoutMs, retries: 0, internal: false,
    headers: { authorization: `Bearer ${config.pspApiKey}`, ...(idemKey ? { 'idempotency-key': idemKey } : {}) },
  });
}

async function emitPaymentEvent(session, type, attempt, correlationId) {
  await addOutbox(session, {
    eventType: type, producer: 'payment', aggregateId: attempt.orderId, correlationId,
    payload: { orderId: attempt.orderId, customerId: attempt.customerId || null, amount: attempt.amount, currency: attempt.currency, provider: attempt.provider, providerRef: attempt.providerRef, failureCode: attempt.failureCode || null },
  });
}

// Transition attempt with guarded update. Returns {changed, attempt}.
async function transitionAttempt(id, fromStates, to, extra = {}, session) {
  const q = { _id: id, status: { $in: fromStates } };
  const update = { $set: { status: to, updatedAt: new Date(), ...extra } };
  if (session) return Attempt.findOneAndUpdate(q, update, { new: true, session });
  return Attempt.findOneAndUpdate(q, update, { new: true });
}

const authorizeSchema = z.object({
  orderId: z.string().min(4).max(64),
  amount: z.number().int().positive(),
  currency: z.string().length(3).default('INR'),
  scenario: z.enum(['success', 'failure', 'async', 'timeout']).default('success'),
  customerId: z.string().optional(),
});

// POST /internal/payments/authorize
app.post('/internal/payments/authorize', asyncH(async (req, res) => {
  const { orderId, amount, currency, scenario, customerId } = validate(authorizeSchema, req.body);
  const idemKey = `order-${orderId}`;

  let attempt = await Attempt.findOne({ orderId });
  if (attempt && TERMINAL.includes(attempt.status)) {
    return res.status(200).json({ status: attempt.status, attempt, replayed: true });
  }
  if (!attempt) {
    attempt = await Attempt.create({ _id: crypto.randomUUID(), orderId, idemKey, amount, currency, scenario, status: 'CREATED', customerId });
  }

  await transitionAttempt(attempt._id, ['CREATED', 'PROCESSING'], 'PROCESSING');

  // Call mock PSP with stable idempotency key
  // 3s hard timeout so the "timeout" scenario (intent authorizes at the PSP but the
  // response is delayed 8s) falls back to the reconciler instead of blocking checkout.
  const pspRes = await pspCall('/psp/v1/payment_intents', { method: 'POST', body: { amount, currency, scenario, metadata: { orderId } }, idemKey, timeoutMs: 3000 });

  if (!pspRes.ok && pspRes.status !== 200) {
    // PSP unreachable or error: keep PROCESSING; reconciler will resolve.
    const cur = await Attempt.findById(attempt._id);
    return res.status(202).json({ status: cur.status, attempt: cur, pending: true });
  }
  const intent = pspRes.data;
  const providerRef = intent.id;
  await Attempt.updateOne({ _id: attempt._id }, { $set: { providerRef, updatedAt: new Date() } });

  if (intent.status === 'authorized') {
    // Synchronous authorization (success / timeout-delayed)
    const result = await withTxn(async (session) => {
      const a = await transitionAttempt(attempt._id, ['CREATED', 'PROCESSING', 'AUTHORIZED'], 'AUTHORIZED', { authorizedAt: new Date(), providerRef }, session);
      if (a) await emitPaymentEvent(session, 'PaymentAuthorized.v1', a, req.correlationId);
      return a;
    });
    const a = result.result || (await Attempt.findById(attempt._id));
    return res.status(200).json({ status: a.status, attempt: a });
  }
  if (intent.status === 'failed') {
    const result = await withTxn(async (session) => {
      const a = await transitionAttempt(attempt._id, ['CREATED', 'PROCESSING', 'FAILED'], 'FAILED', { failureCode: intent.failure_code || 'card_declined', providerRef }, session);
      if (a) await emitPaymentEvent(session, 'PaymentFailed.v1', a, req.correlationId);
      return a;
    });
    const a = result.result || (await Attempt.findById(attempt._id));
    return res.status(200).json({ status: a.status, attempt: a });
  }
  // async / processing
  return res.status(202).json({ status: 'PROCESSING', attempt: { ...attempt.toObject(), providerRef }, pending: true });
}));

// POST /internal/payments/void
const voidSchema = z.object({ orderId: z.string().min(4) });
app.post('/internal/payments/void', asyncH(async (req, res) => {
  const { orderId } = validate(voidSchema, req.body);
  const attempt = await Attempt.findOne({ orderId });
  if (!attempt) return res.json({ orderId, status: 'NOT_FOUND', voided: false });
  if (attempt.status === 'VOIDED') return res.json({ orderId, status: 'VOIDED', voided: true, replayed: true });
  if (attempt.status === 'CAPTURED') throw new HttpError(409, 'ALREADY_CAPTURED', 'Payment already captured');
  if (attempt.providerRef) {
    await pspCall(`/psp/v1/payment_intents/${attempt.providerRef}/cancel`, { method: 'POST', body: {}, timeoutMs: 3000 }).catch(() => {});
  }
  const a = await transitionAttempt(attempt._id, ['CREATED', 'PROCESSING', 'AUTHORIZED', 'FAILED'], 'VOIDED', {});
  res.json({ orderId, status: a ? 'VOIDED' : attempt.status, voided: !!a });
}));

// Capture on OrderConfirmed.v1
async function captureForOrder(orderId, correlationId) {
  const attempt = await Attempt.findOne({ orderId });
  if (!attempt || attempt.status !== 'AUTHORIZED') return;
  if (attempt.providerRef) {
    await pspCall(`/psp/v1/payment_intents/${attempt.providerRef}/capture`, { method: 'POST', body: {}, timeoutMs: 3000 }).catch(() => {});
  }
  await transitionAttempt(attempt._id, ['AUTHORIZED'], 'CAPTURED');
}

// ---- Webhook endpoint (public, signature-verified, raw body) ------------------
app.post('/v1/webhooks/payments/:provider', asyncH(async (req, res) => {
  const provider = req.params.provider;
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  const sig = req.header('stripe-signature') || req.header('x-signature');
  const check = verify(raw, sig, config.pspWebhookSecret);
  if (!check.ok) throw new HttpError(400, 'BAD_SIGNATURE', `Webhook rejected: ${check.reason}`);

  let event;
  try { event = JSON.parse(raw.toString()); } catch { throw new HttpError(400, 'BAD_BODY', 'Webhook body is not JSON'); }
  const eventId = event.event_id || event.id;
  if (!eventId) throw new HttpError(400, 'BAD_EVENT', 'Missing event id');

  // Dedupe
  const existing = await WebhookEvent.findById(eventId);
  if (existing) return res.json({ received: true, duplicate: true });
  await WebhookEvent.create({ _id: eventId, provider, type: event.type, payload: event, processed: false });

  const intent = event.data && event.data.object;
  const orderId = intent && intent.metadata && intent.metadata.orderId;
  const type = event.type;

  if (intent && intent.id) {
    const attempt = await Attempt.findOne({ providerRef: intent.id }) || (orderId ? await Attempt.findOne({ orderId }) : null);
    // Stale/out-of-order events are ignored via guarded transitions; authorized-after-void -> cancel at PSP.
    if (attempt) {
      if (type === 'payment_intent.authorized') {
        if (attempt.status === 'VOIDED') {
          // Late authorization on a dead order: cancel at the PSP.
          await pspCall(`/psp/v1/payment_intents/${intent.id}/cancel`, { method: 'POST', body: {}, timeoutMs: 3000 }).catch(() => {});
        } else {
          await withTxn(async (session) => {
            const a = await transitionAttempt(attempt._id, ['CREATED', 'PROCESSING', 'AUTHORIZED'], 'AUTHORIZED', { authorizedAt: new Date(), providerRef: intent.id }, session);
            if (a) await emitPaymentEvent(session, 'PaymentAuthorized.v1', a, req.correlationId);
          });
        }
      } else if (type === 'payment_intent.failed') {
        await withTxn(async (session) => {
          const a = await transitionAttempt(attempt._id, ['CREATED', 'PROCESSING', 'FAILED'], 'FAILED', { failureCode: (intent.failure_code) || 'card_declined', providerRef: intent.id }, session);
          if (a) await emitPaymentEvent(session, 'PaymentFailed.v1', a, req.correlationId);
        });
      }
    } else if (orderId) {
      // PSP may not have an attempt row yet in edge races; reconciler handles.
      logger.warn('webhook for unknown attempt', { orderId, intentId: intent.id });
    }
  }
  await WebhookEvent.updateOne({ _id: eventId }, { $set: { processed: true } });
  res.json({ received: true });
}));

// Reconciler: every 10s, find stale CREATED/PROCESSING attempts and query the PSP
setInterval(async () => {
  try {
    const stale = await Attempt.find({ status: { $in: ['CREATED', 'PROCESSING'] }, updatedAt: { $lt: new Date(Date.now() - 5000) } }).limit(20);
    for (const attempt of stale) {
      const pspRes = await pspCall(`/psp/v1/payment_intents?idempotency_key=${encodeURIComponent(attempt.idemKey)}`, { timeoutMs: 3000 });
      if (pspRes.status === 404) {
        // PSP never saw it: re-post with same key
        await pspCall('/psp/v1/payment_intents', { method: 'POST', body: { amount: attempt.amount, currency: attempt.currency, scenario: attempt.scenario || 'success', metadata: { orderId: attempt.orderId } }, idemKey: attempt.idemKey, timeoutMs: 3000 });
        continue;
      }
      if (!pspRes.ok) continue;
      const intent = pspRes.data;
      await Attempt.updateOne({ _id: attempt._id }, { $set: { providerRef: intent.id, updatedAt: new Date() } });
      if (intent.status === 'authorized' && transitionGuard(attempt.status, 'AUTHORIZED')) {
        await withTxn(async (session) => {
          const a = await transitionAttempt(attempt._id, ['CREATED', 'PROCESSING'], 'AUTHORIZED', { authorizedAt: new Date(), providerRef: intent.id }, session);
          if (a) await emitPaymentEvent(session, 'PaymentAuthorized.v1', a);
        });
      } else if (intent.status === 'failed' && transitionGuard(attempt.status, 'FAILED')) {
        await withTxn(async (session) => {
          const a = await transitionAttempt(attempt._id, ['CREATED', 'PROCESSING'], 'FAILED', { failureCode: intent.failure_code || 'card_declined', providerRef: intent.id }, session);
          if (a) await emitPaymentEvent(session, 'PaymentFailed.v1', a);
        });
      }
    }
  } catch (err) {
    logger.warn('reconciler error', { err: err.message });
  }
}, 10000).unref();

(async () => {
  await connectMongo('payments');
  await amqpConnect().catch(() => {});
  startOutboxRelay('payment');
  await consume('payment.order-confirmed', async (envl) => { await captureForOrder((envl.payload || {}).orderId); });
  await consume('payment.order-cancelled', async (envl) => {
    const orderId = (envl.payload || {}).orderId;
    if (!orderId) return;
    const attempt = await Attempt.findOne({ orderId });
    if (!attempt || ['VOIDED', 'CAPTURED'].includes(attempt.status)) return;
    if (attempt.providerRef) await pspCall(`/psp/v1/payment_intents/${attempt.providerRef}/cancel`, { method: 'POST', body: {}, timeoutMs: 3000 }).catch(() => {});
    await transitionAttempt(attempt._id, ['CREATED', 'PROCESSING', 'AUTHORIZED', 'FAILED'], 'VOIDED');
  });
  finish(app);
  listen(app, PORT, 'payment');
})().catch((err) => { logger.error('payment failed to start', { err: err.message }); process.exit(1); });
