'use strict';
// Load test V-12: browse (default) and checkout workloads.
// Usage (browse):   node tests/load/load.js
// Usage (checkout): node tests/load/load.js   — see WORKLOAD below.
//
// WORKLOAD=browse    public storefront mix (products, categories, search, availability)
// WORKLOAD=checkout  authenticated checkout (add 1 item + POST /v1/checkout, unique key each iteration).
//                    Requires CHECKOUT_RATE_LIMIT_PER_MIN raised high on the gateway for the run.
//
// Env: BASE_URL=http://127.0.0.1:8080 DURATION_S=20 CONCURRENCY=20 WORKLOAD=browse ADMIN_EMAIL=admin@bazaarly.test ADMIN_PASSWORD=Admin@12345
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
const DURATION_S = parseInt(process.env.DURATION_S || '20', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '20', 10);
const WORKLOAD = process.env.WORKLOAD || 'browse';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@bazaarly.test';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@12345';
const STRESS_SKU = process.env.STRESS_SKU || 'BZ-SPRT-0005';

const latencies = [];
let ok = 0, err = 0;
const stopAt = Date.now() + DURATION_S * 1000;

function pct(sorted, p) { const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length)); return sorted[i]; }

async function http(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  const cookies = (res.headers.getSetCookie ? res.headers.getSetCookie() : []).join(';');
  const cookie = (cookies.match(/token=([^;]+)/) || [])[1] || null;
  return { status: res.status, json, cookie, headers: res.headers };
}

const cookieHeader = (token, csrf) => ({ cookie: `token=${token}`, 'x-csrf-token': csrf, 'content-type': 'application/json' });

const browsePool = [
  { path: '/v1/products?limit=12', weight: 3 },
  { path: '/v1/categories', weight: 1 },
  { path: '/v1/search?q=wireless&limit=10', weight: 2 },
  { path: '/v1/availability?skus=BZ-ELEC-0001,BZ-BOOK-0001,BZ-SPRT-0001', weight: 1 },
].flatMap((e) => Array(e.weight).fill(e.path));

async function workerBrowse() {
  while (Date.now() < stopAt) {
    const path = browsePool[Math.floor(Math.random() * browsePool.length)];
    const t0 = process.hrtime.bigint();
    try {
      const res = await fetch(BASE + path);
      await res.arrayBuffer();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      latencies.push(ms);
      if (res.ok) ok++; else err++;
    } catch { err++; }
  }
}

// ---- checkout workload -------------------------------------------------------
async function makeCheckoutUser(idx) {
  const email = `load-${Date.now().toString(36)}-${idx}@test.local`;
  const reg = await http('/v1/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Load Tester', email, password: 'LoadTest@123' }) });
  if (reg.status !== 201) throw new Error(`load user register failed: ${reg.status} ${JSON.stringify(reg.json)}`);
  const token = reg.cookie;
  const csrf = reg.json.csrfToken;
  const addr = await http('/v1/addresses', { method: 'POST', headers: cookieHeader(token, csrf), body: JSON.stringify({ name: 'Load Tester', phone: '9876543210', line1: `${idx + 1}, Load Street`, city: 'Goa', state: 'Goa', pincode: '403001' }) });
  const addressId = addr.json?.addresses?.[addr.json.addresses.length - 1]?._id;
  if (!addressId) throw new Error('address creation failed');
  return { token, csrf, addressId };
}

async function prepareCheckout(userCount) {
  // Top up the stress SKU so 100s of concurrent checkouts do not drain stock.
  const admin = await http('/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }) });
  if (admin.status !== 200) throw new Error(`admin login failed: ${admin.status}`);
  const inv = await http('/v1/admin/inventory', { headers: { cookie: `token=${admin.cookie}` } });
  const row = (inv.json.inventory || []).find((b) => b.sku === STRESS_SKU);
  const current = row ? row.onHand : 0;
  const delta = Math.max(0, 100000 - current);
  if (delta > 0) {
    await http('/v1/admin/inventory-adjustments', { method: 'POST', headers: cookieHeader(admin.cookie, admin.json.csrfToken), body: JSON.stringify({ sku: STRESS_SKU, delta, reason: 'v12 load-test top-up', confirmLarge: true }) });
  }
  const users = await Promise.all(Array.from({ length: userCount }, (_, i) => makeCheckoutUser(i)));
  console.log(`checkout workload: ${userCount} users, sku=${STRESS_SKU} (top-up +${delta})`);
  return users;
}

let checkoutCtx = null;
let workerIdx = 0;
async function workerCheckout() {
  // One account per worker — each checkout clears the cart, so fresh accounts
  // avoid false CART_EMPTY races between concurrent iterations.
  const me = checkoutCtx[workerIdx++ % checkoutCtx.length];
  const { token, csrf, addressId } = me;
  while (Date.now() < stopAt) {
    const put = await fetch(BASE + `/v1/cart/items/${STRESS_SKU}`, { method: 'PUT', headers: cookieHeader(token, csrf), body: JSON.stringify({ quantity: 1 }) });
    if (!put.ok) { err++; continue; }
    const key = `load-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.floor(Math.random() * 1e6)}`;
    const t0 = process.hrtime.bigint();
    try {
      const res = await fetch(BASE + '/v1/checkout', { method: 'POST', headers: { ...cookieHeader(token, csrf), 'Idempotency-Key': key }, body: JSON.stringify({ addressId, paymentScenario: 'success' }) });
      await res.arrayBuffer();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      latencies.push(ms);
      if (res.status === 201 || res.status === 202) ok++; else err++;
    } catch { err++; }
  }
}

(async () => {
  console.log(`Load: WORKLOAD=${WORKLOAD} ${CONCURRENCY} workers for ${DURATION_S}s against ${BASE}`);
  if (WORKLOAD === 'checkout') checkoutCtx = await prepareCheckout(Math.max(CONCURRENCY, 2));
  const worker = WORKLOAD === 'checkout' ? workerCheckout : workerBrowse;
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  latencies.sort((a, b) => a - b);
  const total = ok + err;
  const report = {
    base: BASE, workload: WORKLOAD, duration_s: DURATION_S, concurrency: CONCURRENCY,
    requests: total, ok, errors: err, error_rate: total ? +(err / total).toFixed(4) : 0,
    rps: +(total / DURATION_S).toFixed(1),
    latency_ms: latencies.length ? { min: +latencies[0].toFixed(1), p50: +pct(latencies, 50).toFixed(1), p95: +pct(latencies, 95).toFixed(1), p99: +pct(latencies, 99).toFixed(1), max: +latencies[latencies.length - 1].toFixed(1) } : null,
    saved_at: new Date().toISOString(),
  };
  const fs = require('fs');
  const path = require('path');
  const out = path.join(__dirname, `load-report-${WORKLOAD}-${Date.now()}.json`);
  try { fs.writeFileSync(out, JSON.stringify(report, null, 2)); } catch {}
  console.log(JSON.stringify(report, null, 2));
  console.log(`Report saved to ${out}`);
})();
