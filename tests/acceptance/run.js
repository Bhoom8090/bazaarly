'use strict';
// Acceptance tests V-01..V-07, V-10 — run against the running stack.
// Usage: BASE_URL=http://localhost:8080 node tests/acceptance/run.js
// (V-08, V-09, V-11 are manual; V-12 is tests/load/load.js.)
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@bazaarly.test';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@12345';
const PSP_WEBHOOK_SECRET = process.env.PSP_WEBHOOK_SECRET || 'whsec_dev_mock_secret';
const UNIQUE = Date.now().toString(36);

const results = [];
function pass(id, detail) { results.push({ id, ok: true, detail }); console.log(`  ✅ ${id} — ${detail}`); }
function fail(id, detail) { results.push({ id, ok: false, detail }); console.log(`  ❌ ${id} — ${detail}`); }

function setCookieValue(res) {
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of cookies) { const m = c.match(/^token=([^;]+)/); if (m) return m[1]; }
  return null;
}
const cookieHeader = (token) => ({ cookie: `token=${token}` });

async function call(path, { method = 'GET', token, csrf, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.cookie = `token=${token}`;
  if (csrf) h['x-csrf-token'] = csrf;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, json, headers: res.headers, cookie: setCookieValue(res) };
}

async function login(email, password) {
  const res = await call('/v1/auth/login', { method: 'POST', body: { email, password } });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.json)}`);
  return { token: res.cookie, csrf: res.json.csrfToken, user: res.json.user };
}

async function registerUser(label) {
  const email = `acc-${label}-${UNIQUE}@test.local`;
  const res = await call('/v1/auth/register', { method: 'POST', body: { name: `Acc ${label}`, email, password: 'Accept@123' } });
  if (res.status !== 201) throw new Error(`register failed: ${res.status}`);
  return { token: res.cookie, csrf: res.json.csrfToken, user: res.json.user, email };
}

(async () => {
  console.log(`Bazaarly acceptance tests against ${BASE}\n`);

  // ---------- V-01: browse + pagination, inactive hidden ----------
  try {
    const p1 = await call('/v1/products?limit=10');
    const p2 = await call(`/v1/products?limit=10&cursor=${encodeURIComponent(p1.json.nextCursor)}`);
    const ids1 = new Set(p1.json.items.map((i) => i.productId));
    const overlap = p2.json.items.filter((i) => ids1.has(i.productId));
    const activeOnly = [...p1.json.items, ...p2.json.items].every((i) => i.status !== 'inactive');
    if (p1.status === 200 && p2.status === 200 && overlap.length === 0 && activeOnly) pass('V-01', `pagination OK, no overlap, active only (page1 ${p1.json.items.length}, page2 ${p2.json.items.length})`);
    else fail('V-01', `overlap=${overlap.length} status=${p1.status}/${p2.status}`);
  } catch (e) { fail('V-01', e.message); }

  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

  // Prepare a stock=1 SKU for concurrency test (use BZ-SPRT-0005)
  const V02_SKU = 'BZ-SPRT-0005';
  try {
    const inv = await call('/v1/admin/inventory', { token: admin.token });
    const row = (inv.json.inventory || []).find((b) => b.sku === V02_SKU);
    const current = row ? row.onHand : 50;
    const delta = 1 - current;
    if (delta !== 0) {
      await call('/v1/admin/inventory-adjustments', { method: 'POST', token: admin.token, csrf: admin.csrf, body: { sku: V02_SKU, delta, reason: 'v02 concurrency setup', confirmLarge: Math.abs(delta) > 100 } });
    }
    // Reset carts responsibility: each test user gets own cart with 1 unit
    const N = 50;
    const users = [];
    for (let i = 0; i < N; i++) users.push(registerUser(`v02-${i}`).catch(() => null));
    const registered = (await Promise.all(users)).filter(Boolean);
    await Promise.all(registered.map((u) => call('/v1/cart/items/' + encodeURIComponent(V02_SKU), { method: 'PUT', token: u.token, csrf: u.csrf, body: { quantity: 1 } })));
    // Give every test user a fresh delivery address
    for (let i = 0; i < registered.length; i++) {
      const u = registered[i];
      const a = await call('/v1/addresses', { method: 'POST', token: u.token, csrf: u.csrf, body: { name: `V02 Tester ${i}`, phone: '9876543210', line1: `${i + 1}, Test Street`, city: 'Bengaluru', state: 'Karnataka', pincode: '560001' } });
      u.addressId = a.json?.addresses?.[a.json.addresses.length - 1]?._id;
    }
    const checkouts = await Promise.allSettled(registered.map((u, i) => call('/v1/checkout', { method: 'POST', token: u.token, csrf: u.csrf, headers: { 'Idempotency-Key': `v02-${UNIQUE}-${i}-${Math.random().toString(36).slice(2)}` }, body: { addressId: u.addressId, paymentScenario: 'success' } })));
    // Addresses are required for checkout; give users one by registering address first would be heavy —
    // if checkout returned ADDRESS_NOT_FOUND for all, V-02 cannot run: mark as fail with hint.
    const statuses = checkouts.map((c) => (c.status === 'fulfilled' ? c.value.status : 0));
    const winners = statuses.filter((s) => s === 201 || s === 202).length;
    const refused = statuses.filter((s) => s === 409).length;
    const addrErr = statuses.filter((s) => s === 400).length;
    if (addrErr === statuses.length) fail('V-02', 'all checkouts failed with 400 ADDRESS_NOT_FOUND — create an address in demo account first or fix test');
    else if (winners === 1) pass('V-02', `exactly one winner out of ${statuses.length} parallel checkouts for 1 unit in stock`);
    else fail('V-02', `winners=${winners} refused=${refused} (statuses: ${[...new Set(statuses)].join(',')})`);
  } catch (e) { fail('V-02', e.message); }

  // ---------- V-03: same key twice -> one logical order ----------
  try {
    const u = await registerUser('v03');
    // address needed: reuse admin-created demo address? Demo user has one. Use demo login.
    const demo = await login('demo@bazaarly.test', 'Demo@12345');
    const demoAddr = demo.user.addresses[0]._id;
    const key = `v03-${UNIQUE}-key-abc123`;
    // Ensure cart has an item for demo user
    await call('/v1/cart/items/BZ-BOOK-0001', { method: 'PUT', token: demo.token, csrf: demo.csrf, body: { quantity: 1 } });
    const first = await call('/v1/checkout', { method: 'POST', token: demo.token, csrf: demo.csrf, headers: { 'Idempotency-Key': key }, body: { addressId: demoAddr, paymentScenario: 'success' } });
    const second = await call('/v1/checkout', { method: 'POST', token: demo.token, csrf: demo.csrf, headers: { 'Idempotency-Key': key }, body: { addressId: demoAddr, paymentScenario: 'success' } });
    const sameOrder = first.json?.order?._id && first.json.order._id === second.json?.order?._id;
    const replayed = second.headers.get('idempotent-replayed') === 'true' || second.json?.replayed === true;
    if (sameOrder && replayed) pass('V-03', `replay returned the same order ${first.json.order._id} with Idempotent-Replayed`);
    else fail('V-03', `first=${first.status} second=${second.status} sameOrder=${sameOrder} replayed=${replayed}`);
  } catch (e) { fail('V-03', e.message); }

  // ---------- V-04: same key, different body -> 409 ----------
  try {
    const demo = await login('demo@bazaarly.test', 'Demo@12345');
    const key = `v04-${UNIQUE}-key-abc123`;
    await call('/v1/cart/items/BZ-BOOK-0003', { method: 'PUT', token: demo.token, csrf: demo.csrf, body: { quantity: 1 } });
    const demoAddr = demo.user.addresses[0]._id;
    await call('/v1/checkout', { method: 'POST', token: demo.token, csrf: demo.csrf, headers: { 'Idempotency-Key': key }, body: { addressId: demoAddr, paymentScenario: 'success' } });
    const reused = await call('/v1/checkout', { method: 'POST', token: demo.token, csrf: demo.csrf, headers: { 'Idempotency-Key': key }, body: { addressId: demoAddr, paymentScenario: 'failure' } });
    if (reused.status === 409 && reused.json?.error?.code === 'IDEMPOTENCY_KEY_REUSED') pass('V-04', 'key reuse with different body rejected with 409 IDEMPOTENCY_KEY_REUSED');
    else fail('V-04', `status=${reused.status} code=${reused.json?.error?.code}`);
  } catch (e) { fail('V-04', e.message); }

  // ---------- V-05: timeout scenario reconciles to CONFIRMED ----------
  try {
    const demo = await login('demo@bazaarly.test', 'Demo@12345');
    await call('/v1/cart/items/BZ-BOOK-0004', { method: 'PUT', token: demo.token, csrf: demo.csrf, body: { quantity: 1 } });
    const demoAddr = demo.user.addresses[0]._id;
    const res = await call('/v1/checkout', { method: 'POST', token: demo.token, csrf: demo.csrf, headers: { 'Idempotency-Key': `v05-${UNIQUE}-key-abc123` }, body: { addressId: demoAddr, paymentScenario: 'timeout' } });
    const orderId = res.json?.order?._id;
    let state = res.json?.order?.state;
    const deadline = Date.now() + 45000;
    while (state !== 'CONFIRMED' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const o = await call(`/v1/orders/${orderId}`, { token: demo.token });
      state = o.json?.order?.state;
    }
    if (state === 'CONFIRMED') pass('V-05', `timeout scenario reconciled to CONFIRMED (order ${orderId})`);
    else fail('V-05', `order stuck in ${state} after 45s (check payment reconciler logs)`);
  } catch (e) { fail('V-05', e.message); }

  // ---------- V-06: failure releases stock exactly once ----------
  try {
    const V06_SKU = 'BZ-SPRT-0003';
    const invBefore = await call('/v1/admin/inventory', { token: admin.token });
    const before = (invBefore.json.inventory || []).find((b) => b.sku === V06_SKU);
    const demo = await login('demo@bazaarly.test', 'Demo@12345');
    await call(`/v1/cart/items/${V06_SKU}`, { method: 'PUT', token: demo.token, csrf: demo.csrf, body: { quantity: 1 } });
    const demoAddr = demo.user.addresses[0]._id;
    const res = await call('/v1/checkout', { method: 'POST', token: demo.token, csrf: demo.csrf, headers: { 'Idempotency-Key': `v06-${UNIQUE}-key-abc123` }, body: { addressId: demoAddr, paymentScenario: 'failure' } });
    await new Promise((r) => setTimeout(r, 3000)); // allow release event to be processed
    const invAfter = await call('/v1/admin/inventory', { token: admin.token });
    const after = (invAfter.json.inventory || []).find((b) => b.sku === V06_SKU);
    const released = before && after && before.reserved === after.reserved; // reserve+release net zero
    if (res.status === 402 && released) pass('V-06', 'failure scenario returned 402 and reservation was released (reserved count unchanged)');
    else fail('V-06', `status=${res.status} beforeReserved=${before?.reserved} afterReserved=${after?.reserved}`);
  } catch (e) { fail('V-06', e.message); }

  // ---------- V-07: bad signature rejected; duplicate webhook is a no-op ----------
  try {
    const crypto = require('crypto');
    const rawBody = JSON.stringify({ event_id: `evt_bad_${UNIQUE}`, type: 'payment_intent.authorized', created: Math.floor(Date.now() / 1000), data: { object: { id: 'pi_fake', metadata: {} } } });
    const bad = await fetch(`${BASE}/v1/webhooks/payments/mockpsp`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=forged' }, body: rawBody });
    const badOk = bad.status === 400;
    // Valid but duplicate webhook
    const bodyObj = { event_id: `evt_dup_${UNIQUE}`, type: 'payment_intent.failed', created: Math.floor(Date.now() / 1000), data: { object: { id: 'pi_nonexistent', metadata: {}, failure_code: 'card_declined' } } };
    const dupBody = JSON.stringify(bodyObj);
    const t = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac('sha256', PSP_WEBHOOK_SECRET).update(`${t}.${dupBody}`).digest('hex');
    const sig = `t=${t},v1=${v1}`;
    const first = await fetch(`${BASE}/v1/webhooks/payments/mockpsp`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: dupBody });
    const second = await fetch(`${BASE}/v1/webhooks/payments/mockpsp`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: dupBody });
    const firstJson = await first.json();
    const secondJson = await second.json();
    if (badOk && first.status === 200 && second.status === 200 && secondJson.duplicate === true) pass('V-07', `bad signature -> 400; duplicate webhook -> { duplicate: true } (first ok=${JSON.stringify(firstJson)})`);
    else fail('V-07', `bad=${bad.status} first=${first.status} second=${second.status} secondJson=${JSON.stringify(secondJson)}`);
  } catch (e) { fail('V-07', e.message); }

  // ---------- V-10: cross-user order read denied ----------
  try {
    const demo = await login('demo@bazaarly.test', 'Demo@12345');
    const ordersRes = await call('/v1/orders', { token: demo.token });
    const victim = ordersRes.json?.orders?.[0];
    const outsider = await registerUser('v10-outsider');
    if (!victim) { fail('V-10', 'demo account has no orders to test against (run V-03 first)'); }
    else {
      const res = await call(`/v1/orders/${victim._id}`, { token: outsider.token });
      if (res.status === 404) pass('V-10', `cross-user read of ${victim._id} returned 404 (existence not leaked)`);
      else fail('V-10', `expected 404, got ${res.status}`);
    }
  } catch (e) { fail('V-10', e.message); }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('Acceptance runner crashed:', e); process.exit(1); });
