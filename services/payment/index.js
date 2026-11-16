'use strict';
// Payment service: attempts (unique per order), provider adapter to mock PSP,
// signed webhooks with dedupe, reconciler for stale attempts, capture/void on order events.
// NO PAN/CVV is ever stored or logged.
require('../../shared/telemetry');
const { z } = require('zod');
const crypto = require('crypto');
const config = require('../../shared/config');
const logger = require('../../shared/logger');
const { createApp, finish, listen, asyncH, validate, HttpError } = require('../../shared/http');
const { connectDb, withTxn, ensureEventTables } = require('../../shared/db');
const { addOutbox, consume, startOutboxRelay, amqpConnect } = require('../../shared/events');
const { callService } = require('../../shared/clients');
const { verify } = require('../../shared/webhook');

const app = createApp('payment', { rawPaths: ['/v1/webhooks/payments/'] });
const PORT = parseInt(process.env.PORT || '4007', 10);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS payment_attempts (
  id              TEXT PRIMARY KEY,
  order_id        TEXT UNIQUE NOT NULL,
  idem_key        TEXT NOT NULL,
  provider        TEXT NOT NULL DEFAULT 'mockpsp',
  provider_ref    TEXT,
  status          TEXT NOT NULL DEFAULT 'CREATED',
  amount          BIGINT NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'INR',
  scenario        TEXT,
  customer_id     TEXT,
  authorized_at   TIMESTAMPTZ,
  failure_code    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attempts_status_idx ON payment_attempts (status, updated_at);
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id     TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  type         TEXT,
  payload      JSONB NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed    BOOLEAN NOT NULL DEFAULT false
);
`;

let pool = null;
const TERMINAL = ['CAPTURED', 'FAILED', 'VOIDED'];
const TRANSITIONS = {
  CREATED: ['PROCESSING', 'AUTHORIZED', 'FAILED', 'VOIDED'],
  PROCESSING: ['AUTHORIZED', 'FAILED', 'VOIDED'],
  AUTHORIZED: ['CAPTURED', 'VOIDED'],
  CAPTURED: [], FAILED: [], VOIDED: [],
};
function canTransitionPayment(from, to) {
  if (TERMINAL.includes(from)) return from === to;
  return (TRANSITIONS[from] || []).includes(to);
}

async function pspCall(path, { method = 'GET', body, idemKey, timeoutMs = 3000 } = {}) {
  return callService(config.services.mockPsp, path, {
    method, body, timeoutMs, retries: 0, internal: false,
    headers: { authorization: `Bearer ${config.pspApiKey}`, ...(idemKey ? { 'idempotency-key': idemKey } : {}) },
  });
}

async function emitPaymentEvent(client, type, attempt, correlationId) {
  await addOutbox(client, {
    eventType: type, producer: 'payment', aggregateId: attempt.order_id, correlationId,
    payload: { orderId: attempt.order_id, customerId: attempt.customer_id || null, amount: Number(attempt.amount), currency: attempt.currency, provider: attempt.provider, providerRef: attempt.provider_ref, failureCode: attempt.failure_code || null },
  });
}

// Guarded transition: no-ops if already in target state (prevents duplicate event emission).
async function transitionAttempt(id, fromStates, to, extra = {}, client) {
  const sets = ['status = $1', 'updated_at = now()'];
  const params = [to];
  let p = 2;
  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = $${p++}`);
    params.push(v);
  }
  params.push(id, fromStates, to);
  const sql = `UPDATE payment_attempts SET ${sets.join(', ')} WHERE id = $${p} AND status = ANY($${p + 1}::text[]) AND status <> $${p + 2} RETURNING *`;
  const r = await (client || pool).query(sql, params);
  return r.rowCount ? r.rows[0] : null;
}

const authorizeSchema = z.object({
  orderId: z.string().min(4).max(64),
  amount: z.number().int().positive(),
  currency: z.string().length(3).default('INR'),
  scenario: z.enum(['success', 'failure', 'async', 'timeout']).default('success'),
  customerId: z.string().optional(),
});

const attemptDto = (a) => a ? { ...a, amount: Number(a.amount) } : a;

// POST /internal/payments/authorize
app.post('/internal/payments/authorize', asyncH(async (req, res) => {
  const { orderId, amount, currency, scenario, customerId } = validate(authorizeSchema, req.body);
  const idemKey = `order-${orderId}`;

  let attempt = (await pool.query('SELECT * FROM payment_attempts WHERE order_id = $1', [orderId])).rows[0];
  if (attempt && TERMINAL.includes(attempt.status)) {
    return res.status(200).json({ status: attempt.status, attempt: attemptDto(attempt), replayed: true });
  }
  if (!attempt) {
    const ins = await pool.query(
      `INSERT INTO payment_attempts (id, order_id, idem_key, amount, currency, scenario, customer_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'CREATED') RETURNING *`,
      [crypto.randomUUID(), orderId, idemKey, amount, currency, scenario, customerId]);
    attempt = ins.rows[0];
  }

  await transitionAttempt(attempt.id, ['CREATED', 'PROCESSING'], 'PROCESSING');

  const pspRes = await pspCall('/psp/v1/payment_intents', {
    method: 'POST', body: { amount, currency, scenario, metadata: { orderId } }, idemKey, timeoutMs: 3000,
  });

  if (!pspRes.ok && pspRes.status !== 200) {
    const cur = await pool.query('SELECT * FROM payment_attempts WHERE id = $1', [attempt.id]);
    return res.status(202).json({ status: cur.rows[0].status, attempt: attemptDto(cur.rows[0]), pending: true });
  }
  const intent = pspRes.data;
  await pool.query('UPDATE payment_attempts SET provider_ref = $1, updated_at = now() WHERE id = $2', [intent.id, attempt.id]);

  if (intent.status === 'authorized') {
    const r = await withTxn(pool, async (client) => {
      const a = await transitionAttempt(attempt.id, ['CREATED', 'PROCESSING', 'AUTHORIZED'], 'AUTHORIZED', { authorized_at: new Date(), provider_ref: intent.id }, client);
      if (a) await emitPaymentEvent(client, 'PaymentAuthorized.v1', a, req.correlationId);
      return a;
    });
    const a = r.result || (await pool.query('SELECT * FROM payment_attempts WHERE id = $1', [attempt.id])).rows[0];
    return res.status(200).json({ status: a.status, attempt: attemptDto(a) });
  }
  if (intent.status === 'failed') {
    const r = await withTxn(pool, async (client) => {
      const a = await transitionAttempt(attempt.id, ['CREATED', 'PROCESSING', 'FAILED'], 'FAILED', { failure_code: intent.failure_code || 'card_declined', provider_ref: intent.id }, client);
      if (a) await emitPaymentEvent(client, 'PaymentFailed.v1', a, req.correlationId);
      return a;
    });
    const a = r.result || (await pool.query('SELECT * FROM payment_attempts WHERE id = $1', [attempt.id])).rows[0];
    return res.status(200).json({ status: a.status, attempt: attemptDto(a) });
  }
  return res.status(202).json({ status: 'PROCESSING', attempt: { ...attemptDto(attempt), provider_ref: intent.id }, pending: true });
}));

const voidSchema = z.object({ orderId: z.string().min(4) });
app.post('/internal/payments/void', asyncH(async (req, res) => {
  const { orderId } = validate(voidSchema, req.body);
  const attempt = (await pool.query('SELECT * FROM payment_attempts WHERE order_id = $1', [orderId])).rows[0];
  if (!attempt) return res.json({ orderId, status: 'NOT_FOUND', voided: false });
  if (attempt.status === 'VOIDED') return res.json({ orderId, status: 'VOIDED', voided: true, replayed: true });
  if (attempt.status === 'CAPTURED') throw new HttpError(409, 'ALREADY_CAPTURED', 'Payment already captured');
  if (attempt.provider_ref) {
    await pspCall(`/psp/v1/payment_intents/${attempt.provider_ref}/cancel`, { method: 'POST', body: {}, timeoutMs: 3000 }).catch(() => {});
  }
  const a = await transitionAttempt(attempt.id, ['CREATED', 'PROCESSING', 'AUTHORIZED', 'FAILED'], 'VOIDED');
  res.json({ orderId, status: a ? 'VOIDED' : attempt.status, voided: !!a });
}));

// Capture on OrderConfirmed.v1
async function captureForOrder(orderId) {
  const attempt = (await pool.query('SELECT * FROM payment_attempts WHERE order_id = $1', [orderId])).rows[0];
  if (!attempt || attempt.status !== 'AUTHORIZED') return;
  if (attempt.provider_ref) {
    await pspCall(`/psp/v1/payment_intents/${attempt.provider_ref}/capture`, { method: 'POST', body: {}, timeoutMs: 3000 }).catch(() => {});
  }
  await transitionAttempt(attempt.id, ['AUTHORIZED'], 'CAPTURED');
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

  const existing = await pool.query('SELECT 1 FROM webhook_events WHERE event_id = $1', [eventId]);
  if (existing.rowCount) return res.json({ received: true, duplicate: true });
  await pool.query('INSERT INTO webhook_events (event_id, provider, type, payload) VALUES ($1,$2,$3,$4)', [eventId, provider, event.type, raw.toString()]);

  const intent = event.data && event.data.object;
  const orderId = intent && intent.metadata && intent.metadata.orderId;
  const type = event.type;

  if (intent && intent.id) {
    let attempt = (await pool.query('SELECT * FROM payment_attempts WHERE provider_ref = $1', [intent.id])).rows[0];
    if (!attempt && orderId) attempt = (await pool.query('SELECT * FROM payment_attempts WHERE order_id = $1', [orderId])).rows[0];
    if (attempt) {
      if (type === 'payment_intent.authorized') {
        if (attempt.status === 'VOIDED') {
          await pspCall(`/psp/v1/payment_intents/${intent.id}/cancel`, { method: 'POST', body: {}, timeoutMs: 3000 }).catch(() => {});
        } else {
          await withTxn(pool, async (client) => {
            const a = await transitionAttempt(attempt.id, ['CREATED', 'PROCESSING', 'AUTHORIZED'], 'AUTHORIZED', { authorized_at: new Date(), provider_ref: intent.id }, client);
            if (a) await emitPaymentEvent(client, 'PaymentAuthorized.v1', a, req.correlationId);
          });
        }
      } else if (type === 'payment_intent.failed') {
        await withTxn(pool, async (client) => {
          const a = await transitionAttempt(attempt.id, ['CREATED', 'PROCESSING', 'FAILED'], 'FAILED', { failure_code: intent.failure_code || 'card_declined', provider_ref: intent.id }, client);
          if (a) await emitPaymentEvent(client, 'PaymentFailed.v1', a, req.correlationId);
        });
      }
    } else if (orderId) {
      logger.warn('webhook for unknown attempt', { orderId, intentId: intent.id });
    }
  }
  await pool.query('UPDATE webhook_events SET processed = true WHERE event_id = $1', [eventId]);
  res.json({ received: true });
}));

// Reconciler: every 10s, find stale CREATED/PROCESSING attempts and query the PSP
setInterval(async () => {
  try {
    const stale = await pool.query("SELECT * FROM payment_attempts WHERE status IN ('CREATED','PROCESSING') AND updated_at < now() - interval '5 seconds' LIMIT 20");
    for (const attempt of stale.rows) {
      const pspRes = await pspCall(`/psp/v1/payment_intents?idempotency_key=${encodeURIComponent(attempt.idem_key)}`, { timeoutMs: 3000 });
      if (pspRes.status === 404) {
        await pspCall('/psp/v1/payment_intents', { method: 'POST', body: { amount: Number(attempt.amount), currency: attempt.currency, scenario: attempt.scenario || 'success', metadata: { orderId: attempt.order_id } }, idemKey: attempt.idem_key, timeoutMs: 3000 });
        continue;
      }
      if (!pspRes.ok) continue;
      const intent = pspRes.data;
      await pool.query('UPDATE payment_attempts SET provider_ref = $1, updated_at = now() WHERE id = $2', [intent.id, attempt.id]);
      if (intent.status === 'authorized') {
        await withTxn(pool, async (client) => {
          const a = await transitionAttempt(attempt.id, ['CREATED', 'PROCESSING'], 'AUTHORIZED', { authorized_at: new Date(), provider_ref: intent.id }, client);
          if (a) await emitPaymentEvent(client, 'PaymentAuthorized.v1', a);
        });
      } else if (intent.status === 'failed') {
        await withTxn(pool, async (client) => {
          const a = await transitionAttempt(attempt.id, ['CREATED', 'PROCESSING'], 'FAILED', { failure_code: intent.failure_code || 'card_declined', provider_ref: intent.id }, client);
          if (a) await emitPaymentEvent(client, 'PaymentFailed.v1', a);
        });
      }
    }
  } catch (err) {
    logger.warn('reconciler error', { err: err.message });
  }
}, 10000).unref();

(async () => {
  pool = await connectDb('bazaarly_payments');
  await pool.query(SCHEMA);
  await ensureEventTables(pool);
  await amqpConnect().catch(() => {});
  startOutboxRelay('payment', pool);
  await consume('payment.order-confirmed', async (envl) => { await captureForOrder((envl.payload || {}).orderId); }, pool);
  await consume('payment.order-cancelled', async (envl) => {
    const orderId = (envl.payload || {}).orderId;
    if (!orderId) return;
    const attempt = (await pool.query('SELECT * FROM payment_attempts WHERE order_id = $1', [orderId])).rows[0];
    if (!attempt || ['VOIDED', 'CAPTURED'].includes(attempt.status)) return;
    if (attempt.provider_ref) await pspCall(`/psp/v1/payment_intents/${attempt.provider_ref}/cancel`, { method: 'POST', body: {}, timeoutMs: 3000 }).catch(() => {});
    await transitionAttempt(attempt.id, ['CREATED', 'PROCESSING', 'AUTHORIZED', 'FAILED'], 'VOIDED');
  }, pool);
  finish(app);
  listen(app, PORT, 'payment');
})().catch((err) => { logger.error('payment failed to start', { err: err.message }); process.exit(1); });
