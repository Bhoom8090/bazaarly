'use strict';
// Eventing: envelope, transactional outbox (added inside business txns, relayed
// asynchronously), and consumers with processed_events dedupe, exponential
// backoff retry queues and a DLQ. Duplicates are possible; consumers must be idempotent.
// Backed by PostgreSQL (outbox + processed_events tables are per-service DB).
const { v4: uuid } = require('uuid');
const amqp = require('amqplib');
const config = require('./config');
const logger = require('./logger');
const { eventsDlq, outboxUnpublished } = require('./http');
const topo = require('./topology');
const { ensureEventTables } = require('./db');

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

// ---- Outbox ------------------------------------------------------------------
async function addOutbox(client, { eventType, producer, aggregateId, correlationId, causationId, payload }) {
  const envl = envelope({ eventType, producer, aggregateId, correlationId, causationId, payload });
  await client.query(
    'INSERT INTO outbox (event_id, event_type, envelope) VALUES ($1, $2, $3)',
    [envl.event_id, envl.event_type, envl]
  );
  return envl;
}

// ---- AMQP connection with auto-reconnect --------------------------------------
let connection = null;
let channel = null;
let connecting = null;
const consumerRegistry = []; // [{ queueName, handler, pool }]

async function amqpConnect() {
  if (connecting) return connecting;
  connecting = (async () => {
    for (;;) {
      try {
        const conn = await amqp.connect(config.amqpUrl);
        conn.on('close', () => {
          logger.warn('amqp closed');
          connection = null; channel = null; connecting = null;
          setTimeout(() => amqpConnect().catch(() => {}), 1000);
        });
        conn.on('error', () => {});
        const ch = await conn.createChannel();
        await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
        await ch.assertQueue(DLQ, { durable: true });
        await topo.declareAll(ch); // every service declares ALL queues+bindings (idempotent)
        connection = conn;
        channel = ch;
        await attachConsumers(); // re-register all consumers on the NEW channel
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

// ---- Outbox relay --------------------------------------------------------------
function startOutboxRelay(serviceName, pool) {
  const tick = async () => {
    try {
      const ch = await getChannel();
      const pending = await pool.query('SELECT count(*)::int AS c FROM outbox WHERE published_at IS NULL');
      outboxUnpublished.set({ service: serviceName }, pending.rows[0].c);
      const rows = await pool.query('SELECT id, event_id, event_type, envelope FROM outbox WHERE published_at IS NULL ORDER BY created_at LIMIT 50');
      for (const row of rows.rows) {
        const ok = ch.publish(EXCHANGE, row.event_type, Buffer.from(JSON.stringify(row.envelope)), {
          persistent: true, contentType: 'application/json', messageId: row.event_id,
        });
        if (!ok) throw new Error('broker backpressure; will retry next tick');
        await pool.query('UPDATE outbox SET published_at = now() WHERE id = $1', [row.id]);
      }
    } catch (err) {
      logger.warn('outbox relay tick failed', { err: err.message });
    }
  };
  setInterval(tick, 1000).unref();
}

// sendToQueue throws synchronously on a dead channel — guard it.
function sendToQueueSafe(ch, queue, content, options) {
  try {
    ch.sendToQueue(queue, content, options);
    return true;
  } catch (err) {
    logger.warn('sendToQueue failed (broker likely down); message will be retried', { queue, err: err.message });
    return false;
  }
}

// ---- Consumer -----------------------------------------------------------------
async function attachConsumer(ch, queueName, handler, pool) {
  await ch.assertQueue(queueName, { durable: true });
  await ch.prefetch(10);
  ch.consume(queueName, async (msg) => {
    if (!msg) return;
    try {
      let envl;
      try {
        envl = JSON.parse(msg.content.toString());
      } catch {
        try { ch.ack(msg); } catch {}
        return;
      }
      try {
        const seen = await pool.query('SELECT 1 AS x FROM processed_events WHERE event_id = $1', [envl.event_id]);
        if (seen.rowCount) { try { ch.ack(msg); } catch {} return; }
        await handler(envl, msg);
        await pool.query(
          "INSERT INTO processed_events (event_id, queue) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING",
          [envl.event_id, queueName]
        );
        try { ch.ack(msg); } catch {}
      } catch (err) {
        const attempts = ((msg.properties.headers && msg.properties.headers['x-attempts']) || 0) + 1;
        logger.warn('event handler failed', { queue: queueName, event: envl.event_type, attempts, err: err.message });
        if (attempts >= config.eventMaxAttempts) {
          sendToQueueSafe(ch, DLQ, msg.content, { persistent: true, contentType: 'application/json', headers: { ...(msg.properties.headers || {}), 'x-attempts': attempts, 'x-failed-queue': queueName } });
          try { eventsDlq.inc({ queue: queueName }); } catch {}
          try { ch.ack(msg); } catch {}
        } else {
          const backoff = Math.min(60000, 500 * Math.pow(2, attempts)) * (0.5 + Math.random() / 2);
          const retryQueue = `${queueName}.retry`;
          sendToQueueSafe(ch, retryQueue, msg.content, {
            persistent: true,
            contentType: 'application/json',
            expiration: String(Math.round(backoff)),
            headers: { ...(msg.properties.headers || {}), 'x-attempts': attempts },
          });
          try { ch.ack(msg); } catch {}
        }
      }
    } catch (fatal) {
      // Never let an AMQP/dispatch failure kill the process; requeue best-effort.
      logger.error('consumer fatal error', { queue: queueName, err: fatal && fatal.message });
      try { ch.nack(msg, false, true); } catch {}
    }
  });
  logger.info('consuming', { queue: queueName });
}

async function attachConsumers() {
  if (!channel) return;
  for (const { queueName, handler, pool } of consumerRegistry) {
    try {
      await attachConsumer(channel, queueName, handler, pool);
    } catch (err) {
      logger.warn('failed to attach consumer', { queue: queueName, err: err.message });
    }
  }
}

async function consume(queueName, handler, pool) {
  consumerRegistry.push({ queueName, handler, pool });
  const ch = await getChannel();
  await attachConsumer(ch, queueName, handler, pool);
}

// Publish helper for one-off events that are not tied to a DB transaction.
async function publish(eventType, envelopeObj) {
  const ch = await getChannel();
  ch.publish(EXCHANGE, eventType, Buffer.from(JSON.stringify(envelopeObj)), { persistent: true, contentType: 'application/json', messageId: envelopeObj.event_id });
}

// Ensure event infra tables exist (called by services at startup with their pool).
async function ensureEventInfra(pool) {
  await ensureEventTables(pool);
}

module.exports = {
  EXCHANGE, DLQ, envelope, addOutbox, startOutboxRelay, consume, publish, getChannel, amqpConnect, ensureEventInfra,
};
