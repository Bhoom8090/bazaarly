'use strict';
const crypto = require('crypto');
const { sign, verify } = require('../../shared/webhook');

const SECRET = 'whsec_test_secret';
const BODY = JSON.stringify({ event_id: 'evt_1', type: 'payment_intent.authorized' });

test('a freshly signed payload verifies', () => {
  const header = sign(BODY, SECRET);
  expect(verify(BODY, header, SECRET).ok).toBe(true);
});

test('tampered body fails verification', () => {
  const header = sign(BODY, SECRET);
  expect(verify(BODY.replace('authorized', 'failed'), header, SECRET).ok).toBe(false);
});

test('wrong secret fails verification', () => {
  const header = sign(BODY, 'whsec_other');
  expect(verify(BODY, header, SECRET).ok).toBe(false);
});

test('stale timestamp is rejected', () => {
  const t = Math.floor(Date.now() / 1000) - 600; // 10 minutes old
  const header = sign(BODY, SECRET, t);
  const res = verify(BODY, header, SECRET, 300);
  expect(res.ok).toBe(false);
  expect(res.reason).toBe('stale_timestamp');
});

test('timing-safe compare rejects forged hex of wrong length', () => {
  const t = Math.floor(Date.now() / 1000);
  const header = `t=${t},v1=deadbeef`;
  expect(verify(BODY, header, SECRET).ok).toBe(false);
});
