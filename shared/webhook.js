'use strict';
// HMAC-SHA256 webhook signature: header "t=<unix>,v1=<hex>" computed over "<t>.<rawBody>".
const crypto = require('crypto');

const TOLERANCE_SECONDS = 300;

function sign(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  const payload = `${t}.${rawBody.toString()}`;
  const v1 = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `t=${t},v1=${v1}`;
}

function verify(rawBody, header, secret, toleranceSeconds = TOLERANCE_SECONDS) {
  if (!header || typeof header !== 'string') return { ok: false, reason: 'missing_signature' };
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=', 2)).map(([k, v]) => [k && k.trim(), v && v.trim()]));
  const t = parseInt(parts.t, 10);
  const v1 = parts.v1;
  if (!t || !v1) return { ok: false, reason: 'malformed_signature' };
  const age = Math.abs(Math.floor(Date.now() / 1000) - t);
  if (age > toleranceSeconds) return { ok: false, reason: 'stale_timestamp' };
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody.toString()}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

module.exports = { sign, verify, TOLERANCE_SECONDS };
