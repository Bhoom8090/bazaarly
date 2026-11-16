'use strict';
// Notification service: per-user inbox fed by domain events, email via Mailpit.
// Per-user dedupe keys; email failure never affects orders; order state is untouched.
require('../../shared/telemetry');
const nodemailer = require('nodemailer');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const config = require('../../shared/config');
const logger = require('../../shared/logger');
const { createApp, finish, listen, asyncH, validate, requireUser, HttpError } = require('../../shared/http');
const { connectDb, withTxn, ensureEventTables } = require('../../shared/db');
const { consume, amqpConnect } = require('../../shared/events');

const app = createApp('notification');
const PORT = parseInt(process.env.PORT || '4008', 10);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inbox (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  order_id    TEXT,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  read_at     TIMESTAMPTZ,
  email_sent  BOOLEAN NOT NULL DEFAULT false,
  dedupe_key  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS inbox_user_idx ON inbox (user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS preferences (
  user_id  TEXT PRIMARY KEY,
  email    BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id                BIGSERIAL PRIMARY KEY,
  notification_id   TEXT NOT NULL,
  ok                BOOLEAN NOT NULL,
  detail            TEXT,
  at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let pool = null;
const mailer = nodemailer.createTransport({ host: config.smtpHost, port: config.smtpPort, secure: false, ignoreTLS: true, connectionTimeout: 5000 });

const TEMPLATES = {
  'PaymentAuthorized.v1': (p) => ({ subject: `Payment received for order ${p.orderId}`, body: `We have authorized ₹${((p.amount || 0) / 100).toFixed(2)} for order ${p.orderId}.` }),
  'PaymentFailed.v1': (p) => ({ subject: `Payment failed for order ${p.orderId}`, body: `Your payment for order ${p.orderId} failed (${p.failureCode || 'card_declined'}). No money was captured.` }),
  'OrderConfirmed.v1': (p) => ({ subject: `Order ${p.orderId} confirmed`, body: `Thanks! Your order ${p.orderId} is confirmed and being packed.` }),
  'OrderCancelled.v1': (p) => ({ subject: `Order ${p.orderId} cancelled`, body: `Your order ${p.orderId} was cancelled (reason: ${p.reason || 'UNKNOWN'}). Any authorized payment will be voided.` }),
  'TrackingUpdated.v1': (p) => ({ subject: `Order ${p.orderId}: ${p.status}`, body: `Your shipment for order ${p.orderId} is now ${p.status}${p.note ? ' — ' + p.note : ''}.` }),
};

async function notify({ userId, orderId, eventType, payload, dedupeSeed }) {
  const tpl = TEMPLATES[eventType];
  if (!tpl) return;
  const { subject, body } = tpl(payload || {});
  const dedupeKey = `${eventType}:${dedupeSeed || (payload && payload.orderId) || uuid()}`;
  const noteId = uuid();
  // Insert inbox row; on conflict do nothing (idempotent retries)
  const ins = await pool.query(
    `INSERT INTO inbox (id, user_id, order_id, subject, body, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`,
    [noteId, userId, orderId || null, subject, body, dedupeKey]);
  if (!ins.rows.length) return; // duplicate delivery, drop silently
  // Email (failure throws -> consumer retry/backoff -> DLQ)
  const pref = await pool.query('SELECT email FROM preferences WHERE user_id = $1', [userId]);
  const emailEnabled = !pref.rows.length || pref.rows[0].email !== false;
  try {
    if (emailEnabled) {
      await mailer.sendMail({ from: '"Bazaarly" <no-reply@bazaarly.test>', to: `${userId}@customers.bazaarly.test`, subject, text: body });
    }
    await pool.query('UPDATE inbox SET email_sent = $1 WHERE id = $2', [emailEnabled, noteId]);
    await pool.query('INSERT INTO delivery_attempts (notification_id, ok, detail) VALUES ($1,$2,$3)', [noteId, true, 'sent']);
  } catch (err) {
    await pool.query('INSERT INTO delivery_attempts (notification_id, ok, detail) VALUES ($1,$2,$3)', [noteId, false, err.message]);
    logger.warn('email delivery failed', { err: err.message, userId });
    throw err; // let the consumer retry -> DLQ after max attempts
  }
}

const dto = (r) => ({ _id: r.id, userId: r.user_id, orderId: r.order_id, subject: r.subject, body: r.body, readAt: r.read_at, emailSent: r.email_sent, createdAt: r.created_at });

app.get('/v1/notifications', requireUser, asyncH(async (req, res) => {
  const items = await pool.query('SELECT * FROM inbox WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  const unread = await pool.query('SELECT count(*)::int AS n FROM inbox WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  res.json({ notifications: items.rows.map(dto), unreadCount: unread.rows[0].n });
}));

app.post('/v1/notifications/:id/read', requireUser, asyncH(async (req, res) => {
  const r = await pool.query('UPDATE inbox SET read_at = now() WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!r.rowCount) throw new HttpError(404, 'NOT_FOUND', 'Notification not found');
  res.json({ ok: true });
}));

app.post('/v1/notifications/read-all', requireUser, asyncH(async (req, res) => {
  await pool.query('UPDATE inbox SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  res.json({ ok: true });
}));

app.get('/v1/notifications/preferences', requireUser, asyncH(async (req, res) => {
  const r = await pool.query('SELECT email FROM preferences WHERE user_id = $1', [req.user.id]);
  res.json({ preferences: { email: !r.rows.length || r.rows[0].email !== false } });
}));

const prefSchema = z.object({ email: z.boolean() });
app.put('/v1/notifications/preferences', requireUser, asyncH(async (req, res) => {
  const { email } = validate(prefSchema, req.body);
  await pool.query('INSERT INTO preferences (user_id, email) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email', [req.user.id, email]);
  res.json({ preferences: { email } });
}));

(async () => {
  pool = await connectDb('bazaarly_notifications');
  await pool.query(SCHEMA);
  await ensureEventTables(pool);
  await amqpConnect().catch(() => {});
  await consume('notification.events', async (envl) => {
    const p = envl.payload || {};
    const userId = p.customerId || p.userId;
    if (!userId) return; // no recipient, drop silently
    await notify({ userId, orderId: p.orderId, eventType: envl.event_type, payload: p, dedupeSeed: envl.event_id });
  }, pool);
  finish(app);
  listen(app, PORT, 'notification');
})().catch((err) => { logger.error('notification failed to start', { err: err.message }); process.exit(1); });
