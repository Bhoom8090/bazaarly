'use strict';
// HTTP helpers: app factory with correlation ids, prometheus metrics,
// internal-key guard, zod validation, auth principals, error handling.
const express = require('express');
const crypto = require('crypto');
const client = require('prom-client');
const { ZodError } = require('zod');
const config = require('./config');
const logger = require('./logger');

client.collectDefaultMetrics({ prefix: 'bazaarly_' });
const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['service', 'method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
});
const eventsDlq = new client.Counter({
  name: 'events_dlq_total',
  help: 'Messages routed to the DLQ',
  labelNames: ['queue'],
});
const outboxUnpublished = new client.Gauge({
  name: 'outbox_unpublished',
  help: 'Unpublished outbox rows',
  labelNames: ['service'],
});

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function validate(schema, data) {
  try {
    return schema.parse(data === undefined ? {} : data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid request', err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    throw err;
  }
}

function requireUser(req, _res, next) {
  const id = req.header('x-user-id');
  if (!id) return next(new HttpError(401, 'UNAUTHENTICATED', 'Authentication required'));
  req.user = { id, role: req.header('x-user-role') || 'customer', csrf: req.header('x-user-csrf') || '' };
  next();
}

function requireAdmin(req, _res, next) {
  const id = req.header('x-user-id');
  if (!id) return next(new HttpError(401, 'UNAUTHENTICATED', 'Authentication required'));
  if ((req.header('x-user-role') || '') !== 'admin') return next(new HttpError(403, 'FORBIDDEN', 'Admin role required'));
  req.user = { id, role: 'admin', csrf: req.header('x-user-csrf') || '' };
  next();
}

function createApp(name, { rawPaths = [], internalKeyGuard = true } = {}) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const cid = req.header('x-correlation-id') || crypto.randomUUID();
    req.correlationId = cid;
    res.setHeader('x-correlation-id', cid);
    const end = httpDuration.startTimer({ service: name, method: req.method });
    res.on('finish', () => end({ route: req.route?.path || req.path, status: res.statusCode }));
    next();
  });

  // Internal key guard: everything except /health and /metrics needs the key.
  if (internalKeyGuard) {
    app.use((req, res, next) => {
      if (req.path === '/health' || req.path === '/metrics') return next();
      if (req.header('x-internal-key') !== config.internalKey) {
        return next(new HttpError(403, 'INTERNAL_ONLY', 'Missing internal key'));
      }
      next();
    });
  }

  app.use((req, res, next) => {
    if (rawPaths.some((p) => req.path === p || req.path.startsWith(p))) {
      express.raw({ type: () => true, limit: '1mb' })(req, res, next);
    } else {
      express.json({ limit: '1mb' })(req, res, next);
    }
  });

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: name, uptime: process.uptime() }));
  app.get('/metrics', async (_req, res) => {
    res.setHeader('content-type', client.register.contentType);
    res.end(await client.register.metrics());
  });

  return app;
}

// 404 + error handler; call at the end of route registration.
function finish(app) {
  app.use((req, _res, next) => next(new HttpError(404, 'NOT_FOUND', `No route ${req.method} ${req.path}`)));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details, correlationId: req.correlationId } });
    }
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
      return res.status(400).json({ error: { code: 'BAD_BODY', message: 'Malformed request body', correlationId: req.correlationId } });
    }
    logger.error('unhandled error', { err: err && err.message, stack: err && err.stack, path: req.path, correlationId: req.correlationId });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error', correlationId: req.correlationId } });
  });
}

function listen(app, port, name) {
  return app.listen(port, () => logger.info(`${name} listening`, { port }));
}

module.exports = { createApp, finish, listen, HttpError, asyncH, validate, requireUser, requireAdmin, httpDuration, eventsDlq, outboxUnpublished, metricsRegistry: client.register };
