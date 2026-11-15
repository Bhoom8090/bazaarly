'use strict';
// Service-to-service HTTP client: timeout, retry with backoff+jitter on
// network/5xx errors, and a per-host circuit breaker.
const http = require('http');
const https = require('https');
const { URL } = require('url');
const config = require('./config');
const logger = require('./logger');

const breakers = new Map(); // host -> { failures, openUntil }
const FAILURE_THRESHOLD = 5;
const OPEN_MS = 10000;

function breakerFor(host) {
  if (!breakers.has(host)) breakers.set(host, { failures: 0, openUntil: 0 });
  return breakers.get(host);
}

function recordSuccess(host) { const b = breakerFor(host); b.failures = 0; b.openUntil = 0; }
function recordFailure(host) {
  const b = breakerFor(host);
  b.failures += 1;
  if (b.failures >= FAILURE_THRESHOLD) b.openUntil = Date.now() + OPEN_MS;
}
function breakerOpen(host) { return breakerFor(host).openUntil > Date.now(); }

function rawRequest(url, { method = 'GET', headers = {}, body, timeoutMs = 3000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const data = body == null ? null : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    const req = lib.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let parsed = null;
        try { parsed = buf.length ? JSON.parse(buf.toString()) : null; } catch { parsed = buf.toString(); }
        resolve({ status: res.statusCode, data: parsed, headers: res.headers });
      });
    });
    req.on('timeout', () => req.destroy(new Error('ETIMEDOUT')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function callService(base, path, { method = 'GET', body, cid, user, timeoutMs = 3000, retries = 2, internal = true, headers = {} } = {}) {
  const host = new URL(base).host;
  if (breakerOpen(host)) {
    return { ok: false, status: 503, data: { error: { code: 'CIRCUIT_OPEN', message: 'Upstream temporarily unavailable' } } };
  }
  const finalHeaders = {
    ...(cid ? { 'x-correlation-id': cid } : {}),
    ...(internal ? { 'x-internal-key': config.internalKey } : {}),
    ...(user ? { 'x-user-id': user.id, 'x-user-role': user.role || 'customer', 'x-user-csrf': user.csrf || '' } : {}),
    ...headers,
  };
  let attempt = 0;
  let lastErr = null;
  while (attempt <= retries) {
    try {
      const res = await rawRequest(base + path, { method, headers: finalHeaders, body, timeoutMs });
      if (res.status >= 500) recordFailure(host); else recordSuccess(host);
      if (res.status >= 500 && attempt < retries) {
        attempt++;
        await new Promise((r) => setTimeout(r, Math.min(2000, 100 * 2 ** attempt) * (0.5 + Math.random())));
        continue;
      }
      return { ok: res.status >= 200 && res.status < 300, status: res.status, data: res.data };
    } catch (err) {
      recordFailure(host);
      lastErr = err;
      attempt++;
      if (attempt > retries) break;
      await new Promise((r) => setTimeout(r, Math.min(2000, 100 * 2 ** attempt) * (0.5 + Math.random())));
    }
  }
  logger.warn('callService failed', { base, path, err: lastErr && lastErr.message });
  return { ok: false, status: 502, data: { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Upstream unavailable' } } };
}

module.exports = { callService, _breakers: breakers, _resetBreakers: () => breakers.clear() };
