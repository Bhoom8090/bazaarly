'use strict';
// Eventing: envelope, transactional outbox (added inside business txns, relayed
// asynchronously), and consumers with processed_events dedupe, exponential
// backoff retry queues and a DLQ. Duplicates are possible; consumers must be idempotent.
const { v4: uuid } = require('uuid');
const amqp = require('amqplib');
const config = require('./config');
const logger = require('./logger');
const { eventsDlq, outboxUnpublished } = require('./http');
const topo = require('./topology');

const EXCHANGE = 'commerce.events';
const DLQ = 'commerce.dlq';

function envelope({ eventType, producer, aggregateId, correlationId, causationId, payload }) {
  return {
    event_id: uuid(),
    event_type: eventType, // e.g. "OrderConfirmed.v1"
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    producer,
    aggregate_id: aggregateId,
    correlation_id: correlationId || uuid(),
    causation_id: causationId || null,
    payload,
  };
}

// ---- Outbox (mongoose) ------------------------------------------------------
let OutboxModel = null;
function outboxModel() {
  if (OutboxModel) return OutboxModel;
  const { mongoose } = require('./db');
  const schema = new mongoose.Schema({
    event_id: { type: String, required: true, unique: true },
    event_type: { type: String, required: true },
    envelope: { type: Object, required: true },
    createdAt: { type: Date, default: Date.now },
    publishedAt: { type: Date, default: null },
    expireAt: { type: Date, default: () => new Date(Date.now() + 7 * 24 * 3600 * 1000) },
  }, { collection: 'outbox', versionKey: false });
  schema.index({ publishedAt: 1, createdAt: 1 });
  schema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
  OutboxModel = mongoose.model('Outbox', schema);
  return OutboxModel;
}

async function addOutbox(session, { eventType, producer, aggregateId, correlationId, causationId, payload }) {
  const envl = envelope({ eventType, producer, aggregateId, correlationId, causationId, payload });
  await outboxModel().create([{ event_id: envl.event_id, event_type: envl.event_type, envelope: envl }], { session });
  return envl;
}

// ---- AMQP connection with auto-reconnect ------------------------------------
let connection = null;
let channel = null;
let connecting = null;

async function amqpConnect() {
  if (connecting) return connecting;
  connecting = (async () => {
    for (;;) {
      try {
        const conn = await amqp.connect(config.amqpUrl);
        conn.on('close', () => { logger.warn('amqp closed'); connection = null; channel = null; connecting = null; setTimeout(() => amqpConnect().catch(() => {}), 1000); });
        conn.on('error', () => {});
        const ch = await conn.createChannel();
        await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
        await ch.assertQueue(DLQ, { durable: true });
        await topo.declareAll(ch); // every service declares ALL queues+bindings (idempotent)
        connection = conn;
        channel = ch;
        logger.info('amqp connected', { url: config.amqpUrl.replace(/:[^:@]*@/, ':***@') });
        return ch;
      } catch (err) {
        logger.warn('amqp connect failed, retrying', { err: err.message });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  })();
  return connecting;
}

async function getChannel() {
  if (channel) return channel;
  return amqpConnect();
}

// ---- Outbox relay -----------------------------------------------------------
function startOutboxRelay(serviceName) {
  const tick = async () => {
    try {
      const ch = await getChannel();
      const Model = outboxModel();
      const pendingCount = await Model.countDocuments({ publishedAt: null });
      outboxUnpublished.set({ service: serviceName }, pendingCount);
      const rows = await Model.find({ publishedAt: null }).sort({ createdAt: 1 }).limit(50);
      for (const row of rows) {
        const ok = ch.publish(EXCHANGE, row.event_type, Buffer.from(JSON.stringify(row.envelope)), {
          persistent: true, contentType: 'application/json', messageId: row.event_id,
        });
        void ok;
        await Model.updateOne({ _id: row._id }, { $set: { publishedAt: new Date() } });
      }
    } catch (err) {
      logger.warn('outbox relay tick failed', { err: err.message });
    }
  };
  setInterval(tick, 1000).unref();
}

// ---- Consumer ---------------------------------------------------------------
let ProcessedModel = null;
function processedModel() {
  if (ProcessedModel) return ProcessedModel;
  const { mongoose } = require('./db');
  const schema = new mongoose.Schema({
    _id: String, // event_id
    queue: String,
    processedAt: { type: Date, default: Date.now },
    expireAt: { type: Date, default: () => new Date(Date.now() + 7 * 24 * 3600 * 1000) },
  }, { collection: 'processed_events', versionKey: false, _id: false });
  schema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
  ProcessedModel = mongoose.model('ProcessedEvent', schema);
  return ProcessedModel;
}

async function consume(queueName, handler) {
  const ch = await getChannel();
  await ch.assertQueue(queueName, { durable: true });
  await ch.prefetch(10);
  ch.consume(queueName, async (msg) => {
    if (!msg) return;
    let envl;
    try {
      envl = JSON.parse(msg.content.toString());
    } catch {
      ch.ack(msg);
      return;
    }
    const P = processedModel();
    try {
      const seen = await P.findById(envl.event_id);
      if (seen) { ch.ack(msg); return; }
      await handler(envl, msg);
      await P.create({ _id: envl.event_id, queue: queueName }).catch(() => {});
      ch.ack(msg);
    } catch (err) {
      const attempts = ((msg.properties.headers && msg.properties.headers['x-attempts']) || 0) + 1;
      logger.warn('event handler failed', { queue: queueName, event: envl.event_type, attempts, err: err.message });
      if (attempts >= config.eventMaxAttempts) {
        ch.sendToQueue(DLQ, msg.content, { persistent: true, contentType: 'application/json', headers: { ...(msg.properties.headers || {}), 'x-attempts': attempts, 'x-failed-queue': queueName } });
        eventsDlq.inc({ queue: queueName });
        ch.ack(msg);
      } else {
        const backoff = Math.min(60000, 500 * Math.pow(2, attempts)) * (0.5 + Math.random() / 2);
        const retryQueue = `${queueName}.retry`;
        ch.sendToQueue(retryQueue, msg.content, {
          persistent: true,
          contentType: 'application/json',
          expiration: String(Math.round(backoff)),
          headers: { ...(msg.properties.headers || {}), 'x-attempts': attempts },
        });
        ch.ack(msg);
      }
    }
  });
  logger.info('consuming', { queue: queueName });
}

// Publish helper for one-off events that are not tied to a DB transaction
// (e.g. mock-psp webhooks originate externally).
async function publish(eventType, envelopeObj) {
  const ch = await getChannel();
  ch.publish(EXCHANGE, eventType, Buffer.from(JSON.stringify(envelopeObj)), { persistent: true, contentType: 'application/json', messageId: envelopeObj.event_id });
}

module.exports = { EXCHANGE, DLQ, envelope, addOutbox, startOutboxRelay, consume, publish, getChannel, amqpConnect };
