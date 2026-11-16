'use strict';
require('../../shared/telemetry');
// Notification service: per-user inbox fed by domain events, email via Mailpit (nodemailer),
// per-user dedupe keys, preferences, and unread counts. Email failure never affects orders.
const nodemailer = require('nodemailer');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const config = require('../../shared/config');
const logger = require('../../shared/logger');
const { createApp, finish, listen, asyncH, validate, requireUser, HttpError } = require('../../shared/http');
const { connectMongo, mongoose } = require('../../shared/db');
const { consume, amqpConnect } = require('../../shared/events');

const app = createApp('notification');
const PORT = parseInt(process.env.PORT || '4008', 10);

const inboxSchema = new mongoose.Schema({
  userId: { type: String, index: true },
  orderId: String,
  subject: String,
  body: String,
  readAt: { type: Date, default: null },
  emailSent: { type: Boolean, default: false },
  dedupeKey: { type: String, index: true },
  createdAt: { type: Date, default: Date.now },
}, { collection: 'inbox', versionKey: false });
inboxSchema.index({ userId: 1, dedupeKey: 1 }, { unique: true });
const prefSchema = new mongoose.Schema({
  _id: String, // userId
  email: { type: Boolean, default: true },
}, { collection: 'preferences', versionKey: false, _id: false });
const attemptSchema = new mongoose.Schema({
  notificationId: String, ok: Boolean, detail: String, at: { type: Date, default: Date.now },
}, { collection: 'delivery_attempts', versionKey: false });
const Inbox = mongoose.model('NotificationInbox', inboxSchema);
const Pref = mongoose.model('NotificationPreference', prefSchema);
const DeliveryAttempt = mongoose.model('NotificationDeliveryAttempt', attemptSchema);

const mailer = nodemailer.createTransport({ host: config.smtpHost, port: config.smtpPort, secure: false, ignoreTLS: true, connectionTimeout: 5000 });

async function emailForUser(userId) {
  // Best effort: resolve email via identity internal endpoint is heavy; store preference only.
  // We deliver to a deterministic mailpit alias when the real address is unknown.
  return null;
}

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
  let note;
  try {
    note = await Inbox.findOneAndUpdate(
      { userId, dedupeKey },
      { $setOnInsert: { userId, orderId, subject, body, dedupeKey, readAt: null, emailSent: false } },
      { new: true, upsert: true }
    );
  } catch (e) {
    if (e.code === 11000) return; // duplicate delivery, already recorded
    throw e;
  }
  // Email (failure throws -> consumer retry/backoff -> DLQ)
  const pref = await Pref.findById(userId).lean();
  const emailEnabled = !pref || pref.email !== false;
  if (emailEnabled && note.createdAt && Date.now() - new Date(note.createdAt).getTime() < 60000) {
    try {
      const to = await emailForUser(userId) || `${userId}@customers.bazaarly.test`;
      await mailer.sendMail({ from: '"Bazaarly" <no-reply@bazaarly.test>', to, subject, text: body });
      await Inbox.updateOne({ _id: note._id }, { $set: { emailSent: true } });
      await DeliveryAttempt.create({ notificationId: String(note._id), ok: true, detail: 'sent' });
    } catch (err) {
      await DeliveryAttempt.create({ notificationId: String(note._id), ok: false, detail: err.message });
      logger.warn('email delivery failed', { err: err.message, userId });
      throw err; // let the consumer retry -> DLQ after max attempts
    }
  }
}

app.get('/v1/notifications', requireUser, asyncH(async (req, res) => {
  const items = await Inbox.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(50).lean();
  const unreadCount = await Inbox.countDocuments({ userId: req.user.id, readAt: null });
  res.json({ notifications: items, unreadCount });
}));

app.post('/v1/notifications/:id/read', requireUser, asyncH(async (req, res) => {
  const r = await Inbox.findOneAndUpdate({ _id: req.params.id, userId: req.user.id }, { $set: { readAt: new Date() } }, { new: true });
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'Notification not found');
  res.json({ ok: true });
}));

app.post('/v1/notifications/read-all', requireUser, asyncH(async (req, res) => {
  await Inbox.updateMany({ userId: req.user.id, readAt: null }, { $set: { readAt: new Date() } });
  res.json({ ok: true });
}));

app.get('/v1/notifications/preferences', requireUser, asyncH(async (req, res) => {
  const pref = await Pref.findById(req.user.id).lean();
  res.json({ preferences: { email: !pref || pref.email !== false } });
}));

const prefSchemaZod = z.object({ email: z.boolean() });
app.put('/v1/notifications/preferences', requireUser, asyncH(async (req, res) => {
  const { email } = validate(prefSchemaZod, req.body);
  await Pref.findByIdAndUpdate(req.user.id, { $set: { email } }, { upsert: true });
  res.json({ preferences: { email } });
}));

(async () => {
  await connectMongo('notifications');
  await amqpConnect().catch(() => {});
  await consume('notification.events', async (envl) => {
    const p = envl.payload || {};
    const userId = p.customerId || p.userId;
    if (!userId) return; // no recipient, drop silently
    await notify({ userId, orderId: p.orderId, eventType: envl.event_type, payload: p, dedupeSeed: envl.event_id });
  });
  finish(app);
  listen(app, PORT, 'notification');
})().catch((err) => { logger.error('notification failed to start', { err: err.message }); process.exit(1); });
