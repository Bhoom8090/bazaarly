'use strict';
require('../../shared/telemetry');
// API gateway: single public entry. JWT verification (cookie or Bearer) with Redis
// revocation denylist, CSRF enforcement for cookie-authenticated mutations, fixed-window
// rate limits in Redis, route table proxying to internal services, OpenAPI docs.
const express = require('express');
const httpProxy = require('http-proxy');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const redis = require('ioredis');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const swaggerUi = require('swagger-ui-express');
const config = require('../../shared/config');
const logger = require('../../shared/logger');
const { createApp, finish, listen, HttpError } = require('../../shared/http');

// NOTE: gateway never parses bodies — the proxy must forward the raw stream
// (webhooks depend on exact bytes for HMAC verification).
const app = createApp('gateway', { internalKeyGuard: false, parseBody: false });
const PORT = parseInt(process.env.PORT || '8080', 10);
const redisClient = new redis(config.redisUrl, { maxRetriesPerRequest: 2 });
redisClient.on('error', (e) => logger.warn('redis error', { err: e.message }));

app.use(cookieParser());
// NOTE: gateway does NOT parse bodies — webhooks must receive the raw stream.

// Strip any inbound spoofing headers, always.
app.use((req, _res, next) => {
  for (const h of ['x-user-id', 'x-user-role', 'x-user-csrf', 'x-internal-key']) delete req.headers[h];
  next();
});

// ---- Rate limiting (fixed window in Redis) ----------------------------------
async function rateLimit(key, limit, windowSec = 60) {
  try {
    const k = `rl:${key}`;
    const n = await redisClient.incr(k);
    if (n === 1) await redisClient.expire(k, windowSec);
    return n <= limit;
  } catch {
    return true; // fail open if Redis hiccups; gateway still verifies JWT
  }
}

// ---- Auth -------------------------------------------------------------------
async function verifyToken(token) {
  const payload = jwt.verify(token, config.jwtSecret); // throws on invalid/expired
  const revoked = await redisClient.get(`revoked:${payload.jti}`).catch(() => null);
  if (revoked) throw new Error('token revoked');
  return payload;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Route table. Pattern is a regex matched against req.path (no query string).
// target: service base URL. auth: public | user | admin. csrf: enforce for cookie auth.
// rateLimit: bucket name with config-driven limit.
const R = config.services;
const routes = [
  { method: 'POST', pattern: /^\/v1\/auth\/register$/, target: R.identity, auth: 'public', rateLimit: 'auth' },
  { method: 'POST', pattern: /^\/v1\/auth\/login$/, target: R.identity, auth: 'public', rateLimit: 'auth' },
  { method: 'POST', pattern: /^\/v1\/auth\/logout$/, target: null, auth: 'user', csrf: true, local: 'logout' },
  { method: 'GET', pattern: /^\/v1\/auth\/session$/, target: R.identity, auth: 'optional' },
  { method: 'POST', pattern: /^\/v1\/auth\/refresh$/, target: R.identity, auth: 'user', csrf: true },
  { method: null, pattern: /^\/v1\/addresses(\/|$)/, target: R.identity, auth: 'user', csrf: true },

  { method: 'GET', pattern: /^\/v1\/products(\/[^/]+)?$/, target: R.catalog, auth: 'public' },
  { method: 'GET', pattern: /^\/v1\/categories$/, target: R.catalog, auth: 'public' },
  { method: 'GET', pattern: /^\/v1\/search$/, target: R.search, auth: 'public', rateLimit: 'search' },
  { method: 'GET', pattern: /^\/v1\/availability$/, target: R.inventory, auth: 'public' },

  { method: null, pattern: /^\/v1\/cart(\/|$)/, target: R.cart, auth: 'user', csrf: true },
  { method: 'POST', pattern: /^\/v1\/checkout$/, target: R.order, auth: 'user', csrf: true, rateLimit: 'checkout' },
  { method: null, pattern: /^\/v1\/orders\/[^/]+\/tracking$/, target: R.fulfilment, auth: 'user' },
  { method: null, pattern: /^\/v1\/orders(\/|$)/, target: R.order, auth: 'user', csrf: true },

  { method: null, pattern: /^\/v1\/notifications(\/|$)/, target: R.notification, auth: 'user', csrf: true },

  { method: 'POST', pattern: /^\/v1\/webhooks\/payments\/[^/]+$/, target: R.payment, auth: 'public', publicWebhook: true },

  // Admin
  { method: null, pattern: /^\/v1\/admin\/products(\/|$)/, target: R.catalog, auth: 'admin', csrf: true },
  { method: 'GET', pattern: /^\/v1\/admin\/audit$/, target: R.catalog, auth: 'admin' },
  { method: null, pattern: /^\/v1\/admin\/inventory(\/|-|$)/, target: R.inventory, auth: 'admin', csrf: true },
  { method: null, pattern: /^\/v1\/admin\/orders$/, target: R.order, auth: 'admin' },
  { method: null, pattern: /^\/v1\/admin\/shipments(\/|$)/, target: R.fulfilment, auth: 'admin', csrf: true },
  { method: 'POST', pattern: /^\/v1\/admin\/search\/reindex$/, target: R.search, auth: 'admin', csrf: true },
  { method: null, pattern: /^\/v1\/admin\/reports(\/|$)/, target: R.reporting, auth: 'admin', csrf: true },
];

// Global per-IP rate limit
app.use(async (req, res, next) => {
  if (req.path === '/health' || req.path === '/metrics' || req.path.startsWith('/api-docs')) return next();
  const allowed = await rateLimit(`global:${req.ip}`, config.rateLimitPerMin, 60);
  if (!allowed) return next(new HttpError(429, 'RATE_LIMITED', 'Too many requests'));
  next();
});

const proxy = httpProxy.createProxyServer({ changeOrigin: true, ws: false, proxyTimeout: 30000, timeout: 30000 });
proxy.on('error', (err, req, res) => {
  logger.warn('proxy error', { err: err.message, url: req.url });
  if (!res.headersSent) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Upstream service unavailable' } }));
  }
});

// Local handlers
async function handleLogout(req, res, next) {
  try {
    const token = req.cookies?.token;
    if (token) {
      try {
        const payload = jwt.verify(token, config.jwtSecret);
        const ttl = Math.max(1, (payload.exp * 1000 - Date.now()) / 1000);
        await redisClient.set(`revoked:${payload.jti}`, '1', 'EX', Math.floor(ttl));
      } catch { /* already invalid — fine */ }
    }
    res.clearCookie('token', { path: '/' });
    res.json({ ok: true });
  } catch (e) { next(e); }
}

// Single root-level matcher — do NOT mount handlers with app.use(pattern, ...),
// because Express strips the matched prefix from req.url for regex mounts, which
// breaks the proxy path. One middleware, zero path rewriting.
const mounted = routes.map((route) => ({
  method: route.method,
  pattern: route.pattern,
  handler: async (req, res, next) => {
    try {
      const usingCookie = !!req.cookies?.token && !req.header('authorization');
      let principal = null;

      if (route.auth !== 'public' && !route.publicWebhook) {
        const bearer = req.header('authorization')?.startsWith('Bearer ') ? req.header('authorization').slice(7) : null;
        const token = bearer || req.cookies?.token;
        if (token) {
          try {
            principal = await verifyToken(token);
          } catch (e) {
            if (route.auth === 'optional') principal = null;
            else return next(new HttpError(401, 'UNAUTHENTICATED', 'Missing or invalid token'));
          }
        } else if (route.auth === 'optional') {
          principal = null;
        } else {
          return next(new HttpError(401, 'UNAUTHENTICATED', 'Authentication required'));
        }
        if (route.auth === 'admin' && principal?.role !== 'admin') {
          return next(new HttpError(403, 'FORBIDDEN', 'Admin role required'));
        }
        // CSRF: cookie-authenticated mutating requests
        if (route.csrf && usingCookie && principal && MUTATING.has(req.method)) {
          if (req.header('x-csrf-token') !== principal.csrf) {
            return next(new HttpError(403, 'CSRF_TOKEN_MISMATCH', 'X-CSRF-Token header does not match token claim'));
          }
        }
      }

      // Rate limits
      if (route.rateLimit === 'auth') {
        if (!(await rateLimit(`auth:${req.ip}`, config.authRateLimitPerMin, 60))) return next(new HttpError(429, 'RATE_LIMITED', 'Too many auth attempts'));
      } else if (route.rateLimit === 'checkout') {
        if (!(await rateLimit(`checkout:${principal.sub}`, config.checkoutRateLimitPerMin, 60))) return next(new HttpError(429, 'RATE_LIMITED', 'Checkout rate limit exceeded'));
      } else if (route.rateLimit === 'search') {
        if (!(await rateLimit(`search:${principal?.sub || req.ip}`, config.searchRateLimitPerMin, 60))) return next(new HttpError(429, 'RATE_LIMITED', 'Search rate limit exceeded'));
      }

      if (route.local === 'logout') return handleLogout(req, res, next);

      // Proxy with injected headers
      req.headers['x-internal-key'] = config.internalKey;
      req.headers['x-correlation-id'] = req.correlationId;
      if (principal) {
        req.headers['x-user-id'] = principal.sub;
        req.headers['x-user-role'] = principal.role;
        req.headers['x-user-csrf'] = principal.csrf || '';
      }

      proxy.web(req, res, { target: route.target });
    } catch (e) {
      next(e);
    }
  },
}));

app.use((req, res, next) => {
  const method = req.method.toUpperCase();
  const path = req.path; // full path, query already stripped by Express
  for (const m of mounted) {
    if (m.method && m.method !== method) continue;
    if (!m.pattern.test(path)) continue;
    return m.handler(req, res, next);
  }
  next(); // no route matched -> 404 in finish()
});

// OpenAPI docs
try {
  const spec = YAML.parse(fs.readFileSync(path.join(__dirname, 'openapi.yaml'), 'utf8'));
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(spec, { customSiteTitle: 'Bazaarly API docs' }));
} catch (e) {
  logger.warn('openapi.yaml not loaded', { err: e.message });
}

finish(app);
listen(app, PORT, 'gateway');
