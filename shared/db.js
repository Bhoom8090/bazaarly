'use strict';
// PostgreSQL access for all transactional services. One database per service.
// Schema is created idempotently by each service at startup (CREATE TABLE IF NOT EXISTS).
const { Pool } = require('pg');
const config = require('./config');
const logger = require('./logger');

async function connectDb(dbName, { retries = 30, delayMs = 2000 } = {}) {
  const pool = new Pool({
    host: config.postgres.host,
    port: config.postgres.port,
    user: config.postgres.user,
    password: config.postgres.password,
    database: dbName,
    max: 20,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      logger.info('postgres connected', { db: dbName });
      return pool;
    } catch (err) {
      if (attempt >= retries) throw err;
      logger.warn('postgres connect failed, retrying', { db: dbName, attempt, err: err.message });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

class TxnAbort extends Error {
  // Throw inside withTxn to abort and still return a value to the caller.
  constructor(result) {
    super('TXN_ABORT');
    this.result = result;
  }
}

async function withTxn(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return { aborted: false, result };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    if (err instanceof TxnAbort) return { aborted: true, result: err.result };
    throw err;
  } finally {
    client.release();
  }
}

// Tables every transactional service needs for the outbox/deduplication pattern.
const EVENT_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS outbox (
  id            BIGSERIAL PRIMARY KEY,
  event_id      TEXT UNIQUE NOT NULL,
  event_type    TEXT NOT NULL,
  envelope      JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ,
  expire_at     TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days'
);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox (published_at, created_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS processed_events (
  event_id      TEXT PRIMARY KEY,
  queue         TEXT NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expire_at     TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days'
);
`;

async function ensureEventTables(clientOrPool) {
  await clientOrPool.query(EVENT_TABLES_SQL);
}

/**
 * Convenience: clientOrPool may be a Pool or a Client checked out inside a transaction.
 */
async function q(clientOrPool, text, params = []) {
  const res = await clientOrPool.query(text, params);
  return res.rows;
}

module.exports = { connectDb, withTxn, TxnAbort, ensureEventTables, q };
