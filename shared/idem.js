'use strict';
// Stable idempotency-key hashing: sha256 of the canonical (sorted-key) JSON body.
const crypto = require('crypto');

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function hashBody(body) {
  return crypto.createHash('sha256').update(stableStringify(body ?? {})).digest('hex');
}

module.exports = { stableStringify, hashBody };
