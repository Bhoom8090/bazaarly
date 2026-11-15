'use strict';
const { callService, _resetBreakers } = require('../../shared/clients');

// Point the client at a guaranteed-closed port so connections fail fast.
const DEAD = 'http://127.0.0.1:9';

beforeEach(() => _resetBreakers());

test('circuit breaker opens after repeated failures and short-circuits', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await callService(DEAD, '/x', { retries: 0, timeoutMs: 200 });
    expect(r.ok).toBe(false);
  }
  // 6th call should be short-circuited by the open breaker (status 503, CIRCUIT_OPEN) with no network attempt
  const shortCircuited = await callService(DEAD, '/x', { retries: 0, timeoutMs: 200 });
  expect(shortCircuited.status).toBe(503);
  expect(shortCircuited.data.error.code).toBe('CIRCUIT_OPEN');
}, 30000);

test('successful upstream resets the failure count (no breaker trip)', async () => {
  // Use a local server that fails 3 times then succeeds — breaker should not open.
  const http = require('http');
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(hits <= 3 ? 500 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: hits > 3 }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await callService(`http://127.0.0.1:${port}`, '/', { retries: 4, timeoutMs: 1000 });
    expect(res.ok).toBe(true);
    expect(hits).toBe(4);
  } finally {
    server.close();
  }
}, 30000);
