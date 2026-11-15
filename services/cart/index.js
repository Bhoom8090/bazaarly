'use strict';
// Cart service: Redis-backed carts (hash per user, 7d TTL), repriced via catalog on every read.
const { z } = require('zod');
const redis = require('ioredis');
const config = require('../../shared/config');
const logger = require('../../shared/logger');
const { createApp, finish, listen, asyncH, validate, requireUser, HttpError } = require('../../shared/http');
const { consume, amqpConnect } = require('../../shared/events');
const { callService } = require('../../shared/clients');
const { priceLines } = require('../../shared/money');

const app = createApp('cart');
const PORT = parseInt(process.env.PORT || '4005', 10);
const redisClient = new redis(config.redisUrl, { maxRetriesPerRequest: 2 });
redisClient.on('error', (e) => logger.warn('redis error', { err: e.message }));

const CART_TTL = 7 * 24 * 3600;
const key = (userId) => `cart:${userId}`;

async function getCartLines(userId) {
  const raw = await redisClient.hgetall(key(userId));
  return Object.entries(raw).map(([sku, quantity]) => ({ sku, quantity: parseInt(quantity, 10) })).filter((l) => l.quantity > 0);
}

async function reprice(lines) {
  if (!lines.length) return { items: [], pricing: { subtotal: 0, shipping: 0, tax: 0, total: 0, currency: 'INR', freeShippingThreshold: 49900 } };
  const skus = lines.map((l) => l.sku).join(',');
  const res = await callService(config.services.catalog, `/internal/products?skus=${encodeURIComponent(skus)}`, { timeoutMs: 5000, retries: 2 });
  if (!res.ok) throw new HttpError(502, 'CATALOG_UNAVAILABLE', 'Could not price cart');
  const map = new Map((res.data.products || []).map((p) => [p.sku, p]));
  return priceLines(lines, map);
}

app.get('/v1/cart', requireUser, asyncH(async (req, res) => {
  const lines = await getCartLines(req.user.id);
  const { items, pricing } = await reprice(lines);
  res.json({ items, pricing, count: items.reduce((n, i) => n + i.quantity, 0) });
}));

const putItemSchema = z.object({ quantity: z.number().int().min(0).max(config.maxCartQty) });

app.put('/v1/cart/items/:sku', requireUser, asyncH(async (req, res) => {
  const sku = req.params.sku;
  const { quantity } = validate(putItemSchema, req.body);
  // Owner always comes from the authenticated principal.
  if (quantity === 0) {
    await redisClient.hdel(key(req.user.id), sku);
  } else {
    // Verify SKU exists before adding
    const res2 = await callService(config.services.catalog, `/internal/products?skus=${encodeURIComponent(sku)}`, { timeoutMs: 5000, retries: 1 });
    const found = res2.ok && (res2.data.products || []).length > 0;
    if (!found) throw new HttpError(404, 'UNKNOWN_SKU', 'Product not found');
    const existing = await redisClient.hkeys(key(req.user.id));
    if (!existing.includes(sku) && existing.length >= 50) throw new HttpError(400, 'CART_FULL', 'Cart may hold at most 50 distinct SKUs');
    await redisClient.hset(key(req.user.id), sku, String(quantity));
    await redisClient.expire(key(req.user.id), CART_TTL);
  }
  const lines = await getCartLines(req.user.id);
  const { items, pricing } = await reprice(lines);
  res.json({ items, pricing, count: items.reduce((n, i) => n + i.quantity, 0) });
}));

app.delete('/v1/cart', requireUser, asyncH(async (req, res) => {
  await redisClient.del(key(req.user.id));
  res.json({ deleted: true });
}));

// Internal (order service)
app.get('/internal/carts/:userId', asyncH(async (req, res) => {
  const lines = await getCartLines(req.params.userId);
  const { items, pricing } = await reprice(lines);
  res.json({ items, pricing });
}));
app.delete('/internal/carts/:userId', asyncH(async (req, res) => {
  await redisClient.del(key(req.params.userId));
  res.json({ deleted: true });
}));

(async () => {
  await amqpConnect().catch(() => {});
  await consume('cart.order-confirmed', async (envl) => {
    const userId = (envl.payload || {}).customerId;
    if (userId) await redisClient.del(key(userId));
  });
  finish(app);
  listen(app, PORT, 'cart');
})().catch((err) => { logger.error('cart failed to start', { err: err.message }); process.exit(1); });
