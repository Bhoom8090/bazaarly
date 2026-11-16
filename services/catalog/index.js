'use strict';
// Catalog service: products, categories, cursor pagination, Redis cache,
// admin mutations with optimistic concurrency, audit log and outbox events.
require('../../shared/telemetry');
const { z } = require('zod');
const redis = require('ioredis');
const config = require('../../shared/config');
const logger = require('../../shared/logger');
const { createApp, finish, listen, asyncH, validate, requireAdmin, HttpError } = require('../../shared/http');
const { connectDb, withTxn, TxnAbort, ensureEventTables } = require('../../shared/db');
const { addOutbox, startOutboxRelay, amqpConnect } = require('../../shared/events');
const { SEED_PRODUCTS, CATEGORIES } = require('./seed');

const app = createApp('catalog');
const PORT = parseInt(process.env.PORT || '4002', 10);
const redisClient = new redis(config.redisUrl, { maxRetriesPerRequest: 2 });
redisClient.on('error', (e) => logger.warn('redis error', { err: e.message }));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  product_id  TEXT PRIMARY KEY,
  sku         TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  brand       TEXT NOT NULL,
  category    TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price       BIGINT NOT NULL CHECK (price >= 0),
  currency    TEXT NOT NULL DEFAULT 'INR',
  emoji       TEXT NOT NULL DEFAULT '🛍️',
  color       TEXT NOT NULL DEFAULT '#37475a',
  status      TEXT NOT NULL DEFAULT 'active',
  version     INT NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS products_category_idx ON products (category, status, product_id);
CREATE INDEX IF NOT EXISTS products_active_id_idx ON products (status, product_id);

CREATE TABLE IF NOT EXISTS audit (
  id          BIGSERIAL PRIMARY KEY,
  product_id  TEXT NOT NULL,
  sku         TEXT NOT NULL,
  admin_id    TEXT NOT NULL,
  reason      TEXT NOT NULL,
  changes     JSONB NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let pool = null;

const cacheKey = (s) => `catalog:v1:${s}`;
async function cacheGet(k) { try { const v = await redisClient.get(cacheKey(k)); return v ? JSON.parse(v) : null; } catch { return null; } }
async function cacheSet(k, v, ttl = 30) { try { await redisClient.set(cacheKey(k), JSON.stringify(v), 'EX', ttl); } catch {} }
async function cacheInvalidate() { try { const stream = redisClient.scanStream({ match: 'catalog:v1:*', count: 100 }); const keys = []; for await (const batch of stream) keys.push(...batch); if (keys.length) await redisClient.del(keys); } catch {} }

const dto = (r) => ({ productId: r.product_id, sku: r.sku, title: r.title, brand: r.brand, category: r.category, description: r.description, price: Number(r.price), currency: r.currency, emoji: r.emoji, color: r.color, status: r.status, version: r.version });

app.get('/v1/products', asyncH(async (req, res) => {
  const limit = Math.min(40, Math.max(1, parseInt(req.query.limit || '12', 10) || 12));
  const category = req.query.category || null;
  const cursor = req.query.cursor || null;
  const key = `list:${category || 'all'}:${cursor || ''}:${limit}`;
  const cached = await cacheGet(key);
  if (cached) return res.json(cached);
  const params = ['active'];
  let sql = 'SELECT * FROM products WHERE status = $1';
  if (category) { sql += ' AND category = $2'; params.push(category); }
  if (cursor) { sql += ' AND product_id > $' + (params.length + 1); params.push(cursor); }
  sql += ' ORDER BY product_id LIMIT $' + (params.length + 1);
  params.push(limit + 1);
  const r = await pool.query(sql, params);
  const hasMore = r.rows.length > limit;
  const items = r.rows.slice(0, limit).map(dto);
  const body = { items, nextCursor: hasMore && items.length ? items[items.length - 1].productId : null };
  await cacheSet(key, body, 30);
  res.json(body);
}));

app.get('/v1/products/:id', asyncH(async (req, res) => {
  const key = `one:${req.params.id}`;
  const cached = await cacheGet(key);
  if (cached) return res.json(cached);
  const r = await pool.query('SELECT * FROM products WHERE product_id = $1', [req.params.id]);
  if (!r.rows.length) throw new HttpError(404, 'NOT_FOUND', 'Product not found');
  const body = { product: dto(r.rows[0]) };
  await cacheSet(key, body, 30);
  res.json(body);
}));

app.get('/v1/categories', asyncH(async (_req, res) => {
  const r = await pool.query("SELECT category AS name, count(*)::int AS count FROM products WHERE status = 'active' GROUP BY category");
  const countMap = Object.fromEntries(r.rows.map((c) => [c.name, c.count]));
  res.json({ categories: CATEGORIES.map((c) => ({ name: c, count: countMap[c] || 0 })) });
}));

// Internal endpoints
app.get('/internal/products', asyncH(async (req, res) => {
  if (req.query.skus) {
    const skus = String(req.query.skus).split(',').filter(Boolean).slice(0, 100);
    if (!skus.length) return res.json({ products: [] });
    const r = await pool.query('SELECT * FROM products WHERE sku = ANY($1)', [skus]);
    return res.json({ products: r.rows.map(dto) });
  }
  if (req.query.all === '1') {
    const cursor = req.query.cursor || null;
    const params = cursor ? [cursor] : [];
    let sql = 'SELECT * FROM products';
    if (cursor) sql += ' WHERE product_id > $1';
    sql += ' ORDER BY product_id LIMIT 101';
    const r = await pool.query(sql, params);
    const hasMore = r.rows.length > 100;
    const items = r.rows.slice(0, 100).map(dto);
    return res.json({ items, nextCursor: hasMore ? items[items.length - 1].productId : null });
  }
  throw new HttpError(400, 'BAD_QUERY', 'Provide ?skus=a,b or ?all=1');
}));

// ---- Admin ------------------------------------------------------------------
const createSchema = z.object({
  title: z.string().min(2).max(200), brand: z.string().min(1).max(80), category: z.string().min(1).max(60),
  description: z.string().max(2000).default(''), price: z.number().int().positive(), emoji: z.string().max(8).default('🛍️'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#37475a'), sku: z.string().min(3).max(40).optional(), status: z.enum(['active', 'inactive']).default('active'), reason: z.string().min(3).max(500),
});
const updateSchema = z.object({
  title: z.string().min(2).max(200).optional(), brand: z.string().min(1).max(80).optional(), category: z.string().min(1).max(60).optional(),
  description: z.string().max(2000).optional(), price: z.number().int().positive().optional(), emoji: z.string().max(8).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), status: z.enum(['active', 'inactive']).optional(),
  expectedVersion: z.number().int().positive(), reason: z.string().min(3).max(500),
});

app.post('/v1/admin/products', requireAdmin, asyncH(async (req, res) => {
  const data = validate(createSchema, req.body);
  const countR = await pool.query('SELECT count(*)::int AS c FROM products');
  const count = countR.rows[0].c;
  const id = 'p_' + String(count + 1).padStart(4, '0');
  const catCode = (data.category.replace(/[^A-Za-z]/g, '').slice(0, 4) || 'GEN').toUpperCase();
  const sku = data.sku || `BZ-${catCode}-${String(count + 1).padStart(4, '0')}`;
  const result = await withTxn(pool, async (client) => {
    await client.query(
      `INSERT INTO products (product_id, sku, title, brand, category, description, price, currency, emoji, color, status, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'INR',$8,$9,$10,1)`,
      [id, sku, data.title, data.brand, data.category, data.description, data.price, data.emoji, data.color, data.status]);
    await client.query('INSERT INTO audit (product_id, sku, admin_id, reason, changes) VALUES ($1,$2,$3,$4,$5)',
      [id, sku, req.user.id, data.reason, JSON.stringify({ created: data })]);
    await addOutbox(client, {
      eventType: 'ProductChanged.v1', producer: 'catalog', aggregateId: id, correlationId: req.correlationId,
      payload: { productId: id, sku, title: data.title, brand: data.brand, category: data.category, description: data.description, price: data.price, emoji: data.emoji, color: data.color, status: data.status, version: 1, initialStock: 50 },
    });
    return id;
  });
  await cacheInvalidate();
  const created = await pool.query('SELECT * FROM products WHERE product_id = $1', [id]);
  res.status(201).json({ product: dto(created.rows[0]) });
}));

app.put('/v1/admin/products/:id', requireAdmin, asyncH(async (req, res) => {
  const data = validate(updateSchema, req.body);
  const { expectedVersion, reason, ...changes } = data;
  const result = await withTxn(pool, async (client) => {
    const cur = await client.query('SELECT * FROM products WHERE product_id = $1 FOR UPDATE', [req.params.id]);
    if (!cur.rows.length) return null; // not found
    const p = cur.rows[0];
    if (p.version !== expectedVersion) {
      throw new TxnAbort({ conflict: true, currentVersion: p.version });
    }
    const sets = []; const params = [];
    for (const [k, v] of Object.entries(changes)) {
      sets.push(`${k} = $${params.length + 1}`);
      params.push(v);
    }
    params.push(expectedVersion + 1);
    sets.push(`version = $${params.length}`);
    params.push(req.params.id);
    await client.query(`UPDATE products SET ${sets.join(', ')} WHERE product_id = $${params.length}`, params);
    await client.query('INSERT INTO audit (product_id, sku, admin_id, reason, changes) VALUES ($1,$2,$3,$4,$5)',
      [p.product_id, p.sku, req.user.id, reason, JSON.stringify(changes)]);
    const updated = await client.query('SELECT * FROM products WHERE product_id = $1', [p.product_id]);
    await addOutbox(client, {
      eventType: 'ProductChanged.v1', producer: 'catalog', aggregateId: p.product_id, correlationId: req.correlationId,
      payload: { ...dto(updated.rows[0]), productId: p.product_id },
    });
    return updated.rows[0];
  });
  if (result.result === null) throw new HttpError(404, 'NOT_FOUND', 'Product not found');
  if (result.aborted) {
    throw new HttpError(409, 'VERSION_CONFLICT', 'Product was modified by someone else', { currentVersion: result.result.currentVersion });
  }
  await cacheInvalidate();
  res.json({ product: dto(result.result) });
}));

app.get('/v1/admin/audit', requireAdmin, asyncH(async (req, res) => {
  const r = await pool.query('SELECT * FROM audit ORDER BY at DESC LIMIT 100');
  res.json({ audit: r.rows.map((a) => ({ _id: String(a.id), productId: a.product_id, sku: a.sku, adminId: a.admin_id, reason: a.reason, changes: a.changes, at: a.at })) });
}));

// Used by reindex/tests
app.get('/internal/catalog-dump', asyncH(async (_req, res) => {
  const r = await pool.query('SELECT * FROM products ORDER BY product_id');
  res.json({ products: r.rows.map(dto) });
}));

async function seed() {
  const r = await pool.query('SELECT count(*)::int AS c FROM products');
  if (r.rows[0].c > 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of SEED_PRODUCTS) {
      await client.query(
        `INSERT INTO products (product_id, sku, title, brand, category, description, price, currency, emoji, color, status, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [p._id, p.sku, p.title, p.brand, p.category, p.description, p.price, p.currency, p.emoji, p.color, p.status, p.version]);
    }
    await client.query('COMMIT');
    logger.info('seeded products', { count: SEED_PRODUCTS.length });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

(async () => {
  pool = await connectDb('bazaarly_catalog');
  await pool.query(SCHEMA);
  await ensureEventTables(pool);
  await amqpConnect().catch(() => {});
  startOutboxRelay('catalog', pool);
  await seed();
  finish(app);
  listen(app, PORT, 'catalog');
})().catch((err) => { logger.error('catalog failed to start', { err: err.message }); process.exit(1); });
