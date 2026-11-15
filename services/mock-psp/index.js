'use strict';
// MOCK PSP — in-memory fake payment service provider for sandbox testing only.
// Never use real card data. Supports idempotency-key replay and 4 test scenarios.
const express = require('express');
const crypto = require('crypto');
const config = require('../../shared/config');
const logger = require('../../shared/logger');

const app = express();
app.disable('x-powered-by');

// Bearer auth
app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/metrics') return next();
  const auth = req.header('authorization') || '';
  if (auth !== `Bearer ${config.pspApiKey}`) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid PSP API key' } });
  }
  next();
});
app.use(express.json());

const intents = new Map();     // id -> intent
const byIdemKey = new Map();   // idempotency key -> intent id
const PORT = parseInt(process.env.PORT || '4010', 10);

const SCENARIOS = ['success', 'failure', 'async', 'timeout'];

function publicIntent(i) {
  return { id: i.id, status: i.status, amount: i.amount, currency: i.currency, scenario: i.scenario, idempotency_key: i.idempotencyKey, created: i.created, captured: i.captured, failure_code: i.failureCode || null };
}

function sendWebhook(intent, eventType) {
  const body = JSON.stringify({ event_id: crypto.randomUUID(), type: eventType, created: Math.floor(Date.now() / 1000), data: { object: publicIntent(intent) } });
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', config.pspWebhookSecret).update(`${t}.${body}`).digest('hex');
  const url = new URL(config.pspWebhookUrl);
  const http = url.protocol === 'https:' ? require('https') : require('http');
  const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'stripe-signature': `t=${t},v1=${v1}` }, timeout: 5000 }, (res) => { res.resume(); logger.info('webhook delivered', { status: res.statusCode, eventType, intent: intent.id }); });
  req.on('error', (e) => logger.warn('webhook delivery failed', { err: e.message, eventType }));
  req.end(body);
}

// POST /psp/v1/payment_intents
app.post('/psp/v1/payment_intents', (req, res) => {
  const idemKey = req.header('idempotency-key');
  if (!idemKey) return res.status(400).json({ error: { code: 'MISSING_IDEMPOTENCY_KEY', message: 'Idempotency-Key header required' } });
  const existing = byIdemKey.get(idemKey);
  if (existing) return res.status(200).json(publicIntent(intents.get(existing))); // replay

  const { amount, currency = 'INR', scenario = 'success', metadata = {} } = req.body || {};
  if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: { code: 'BAD_AMOUNT', message: 'amount must be positive integer paise' } });
  if (!SCENARIOS.includes(scenario)) return res.status(400).json({ error: { code: 'BAD_SCENARIO', message: `scenario must be one of ${SCENARIOS.join('|')}` } });

  const intent = { id: 'pi_' + crypto.randomBytes(12).toString('hex'), status: 'created', amount, currency, scenario, idempotencyKey: idemKey, created: Math.floor(Date.now() / 1000), captured: false, metadata, failureCode: null };
  intents.set(intent.id, intent);
  byIdemKey.set(idemKey, intent.id);

  // Apply scenario
  if (scenario === 'success') {
    intent.status = 'authorized';
    // Webhook sent twice (deliberate duplicate delivery)
    setImmediate(() => { sendWebhook(intent, 'payment_intent.authorized'); sendWebhook(intent, 'payment_intent.authorized'); });
  } else if (scenario === 'failure') {
    intent.status = 'failed';
    intent.failureCode = 'card_declined';
    setImmediate(() => sendWebhook(intent, 'payment_intent.failed'));
  } else if (scenario === 'async') {
    intent.status = 'processing';
    setTimeout(() => {
      intent.status = 'authorized';
      sendWebhook(intent, 'payment_intent.authorized');
    }, 5000).unref();
  } else if (scenario === 'timeout') {
    // Authorized, but HTTP response delayed 8s and NO webhook is sent -> forces reconciliation.
    intent.status = 'authorized';
    const body = JSON.stringify(publicIntent(intent));
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.setHeader('content-length', Buffer.byteLength(body));
    return setTimeout(() => res.end(body), 8000).unref();
  }
  res.status(200).json(publicIntent(intent));
});

// GET /psp/v1/payment_intents/:id  or  ?idempotency_key=
app.get('/psp/v1/payment_intents', (req, res) => {
  const key = req.query.idempotency_key;
  if (!key) return res.status(400).json({ error: { code: 'BAD_QUERY', message: 'idempotency_key query param required' } });
  const id = byIdemKey.get(key);
  if (!id) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No intent for that idempotency key' } });
  res.json(publicIntent(intents.get(id)));
});
app.get('/psp/v1/payment_intents/:id', (req, res) => {
  const intent = intents.get(req.params.id);
  if (!intent) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Intent not found' } });
  res.json(publicIntent(intent));
});

// POST capture / cancel
app.post('/psp/v1/payment_intents/:id/capture', (req, res) => {
  const intent = intents.get(req.params.id);
  if (!intent) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Intent not found' } });
  if (intent.status === 'authorized') { intent.status = 'captured'; intent.captured = true; }
  res.json(publicIntent(intent));
});
app.post('/psp/v1/payment_intents/:id/cancel', (req, res) => {
  const intent = intents.get(req.params.id);
  if (!intent) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Intent not found' } });
  if (intent.status !== 'captured') intent.status = 'cancelled';
  res.json(publicIntent(intent));
});

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'mock-psp', mock: true }));

app.listen(PORT, () => logger.info('mock-psp listening (IN-MEMORY MOCK, sandbox only)', { port: PORT }));
