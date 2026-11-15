'use strict';
// Mongo connection with retry; multi-document transaction helper.
const mongoose = require('mongoose');
const config = require('./config');
const logger = require('./logger');

async function connectMongo(dbName, { retries = 30, delayMs = 2000 } = {}) {
  const base = config.mongoUri.endsWith('/') ? config.mongoUri.slice(0, -1) : config.mongoUri;
  const uri = `${base}/${dbName}`;
  for (let attempt = 1; ; attempt++) {
    try {
      await mongoose.connect(uri, { maxPoolSize: 20, serverSelectionTimeoutMS: 5000 });
      logger.info('mongo connected', { db: dbName });
      return mongoose.connection;
    } catch (err) {
      if (attempt >= retries) throw err;
      logger.warn('mongo connect failed, retrying', { db: dbName, attempt, err: err.message });
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

async function withTxn(work) {
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      result = await work(session);
    }, { readPreference: 'primary', readConcern: { level: 'majority' }, writeConcern: { w: 'majority' } });
  } catch (err) {
    if (err instanceof TxnAbort) return { aborted: true, result: err.result };
    throw err;
  } finally {
    await session.endSession();
  }
  return { aborted: false, result };
}

module.exports = { connectMongo, withTxn, TxnAbort, mongoose };
