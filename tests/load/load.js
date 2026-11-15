'use strict';
// Load test V-12: hammers the storefront endpoints, reports p50/p95/p99, error rate, RPS.
// Usage: BASE_URL=http://localhost:8080 DURATION_S=20 CONCURRENCY=20 node tests/load/load.js
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const DURATION_S = parseInt(process.env.DURATION_S || '20', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '20', 10);

const endpoints = [
  { path: '/v1/products?limit=12', weight: 3 },
  { path: '/v1/categories', weight: 1 },
  { path: '/v1/search?q=wireless&limit=10', weight: 2 },
  { path: '/v1/availability?skus=BZ-ELEC-0001,BZ-BOOK-0001,BZ-SPRT-0001', weight: 1 },
];
const pool = endpoints.flatMap((e) => Array(e.weight).fill(e.path));

const latencies = [];
let ok = 0, err = 0;
const stopAt = Date.now() + DURATION_S * 1000;

async function worker() {
  while (Date.now() < stopAt) {
    const path = pool[Math.floor(Math.random() * pool.length)];
    const t0 = process.hrtime.bigint();
    try {
      const res = await fetch(BASE + path);
      await res.arrayBuffer();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      latencies.push(ms);
      if (res.ok) ok++; else err++;
    } catch {
      err++;
    }
  }
}

function pct(sorted, p) { const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length)); return sorted[i]; }

(async () => {
  console.log(`Load: ${CONCURRENCY} workers for ${DURATION_S}s against ${BASE}`);
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  latencies.sort((a, b) => a - b);
  const total = ok + err;
  const report = {
    base: BASE, duration_s: DURATION_S, concurrency: CONCURRENCY,
    requests: total, ok, errors: err, error_rate: total ? +(err / total).toFixed(4) : 0,
    rps: +(total / DURATION_S).toFixed(1),
    latency_ms: latencies.length ? { min: +latencies[0].toFixed(1), p50: +pct(latencies, 50).toFixed(1), p95: +pct(latencies, 95).toFixed(1), p99: +pct(latencies, 99).toFixed(1), max: +latencies[latencies.length - 1].toFixed(1) } : null,
    saved_at: new Date().toISOString(),
  };
  const fs = require('fs');
  const path = require('path');
  const out = path.join(__dirname, `load-report-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`Report saved to ${out}`);
})();
