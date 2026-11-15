'use strict';
// Structured JSON logger with secret redaction.
const REDACT = /pan|cvv|card|password|secret|token|authorization|cookie/i;

function redact(value, depth = 0) {
  if (value == null || depth > 6) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 2000) return value.slice(0, 2000) + '…';
  return value;
}

function log(level, msg, meta) {
  const line = { ts: new Date().toISOString(), level, msg, ...(meta ? redact(meta) : {}) };
  process.stdout.write(JSON.stringify(line) + '\n');
}

module.exports = {
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
  debug: (msg, meta) => (process.env.NODE_ENV === 'development' ? log('debug', msg, meta) : undefined),
};
