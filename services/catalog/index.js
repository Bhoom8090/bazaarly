'use strict';
// Catalog service: products, categories, cursor pagination, Redis cache,
// admin mutations with optimistic concurrency, audit log and outbox events.
const { z } = require('zod');
const redis = require('ioredis');
const config = require('../../shared/config');
const logger = require('../../shared/logger');
const { createApp, finish, listen, asyncH, validate, requireAdmin, requireUser, HttpError } = require('../../shared/http');
const { connectMongo, mongoose, withTxn, TxnAbort } = require('../../shared/db');
const { addOutbox, startOutboxRelay, amqpConnect } = require('../../shared/events');
const { SEED_PRODUCTS, CATEGORIES } = require('./seed');

const app = createApp('catalog');
const PORT = parseInt(process.env.PORT || '4002', 10);
const redisClient = new redis(config.redisUrl, { maxRetriesPerRequest: 2 });
redisClient.on('error', (e) => logger.warn('redis error', { err: e.message }));

const productSchema = new mongoose.Schema({
  _id: String,                      // p_0001
  sku: { type: String, unique: true, index: true },
  title: String,
  brand: String,
  category: { type: String, index: true },
  description: String,
  price: Number,                    // paise, GST-inclusive
  currency: { type: String, default: 'INR' },
  emoji: String,
  color: String,                    // gradient base color for the SVG tile
  status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
  version: { type: Number, default: 1 },
}, { collection: 'products', versionKey: false, _id: false });
const auditSchema = new mongoose.Schema({
  productId: String, sku: String, adminId: String, reason: String,
  changes: Object, at: { type: Date, default: Date.now },
}, { collection: 'audit', versionKey: false });
const Product = mongoose.model('CatalogProduct', productSchema);
const Audit = mongoose.model('CatalogAudit', auditSchema);

const cacheKey = (s) => `catalog:v1:${s}`;
async function cacheGet(k) { try { const v = await redisClient.get(cacheKey(k)); return v ? JSON.parse(v) : null; } catch { return null; } }
async function cacheSet(k, v, ttl = 30) { try { await redisClient.set(cacheKey(k), JSON.stringify(v), 'EX', ttl); } catch {} }
async function cacheInvalidate() { try { const stream = redisClient.scanStream({ match: 'catalog:v1:*', count: 100 }); const keys = []; for await (const batch of stream) keys.push(...batch); if (keys.length) await redisClient.del(keys); } catch {} }

const dto = (p) => ({ productId: p._id, sku: p.sku, title: p.title, brand: p.brand, category: p.category, description: p.description, price: p.price, currency: p.currency, emoji: p.emoji, color: p.color, status: p.status, version: p.version });

app.get('/v1/products', asyncH(async (req, res) => {
  const limit = Math.min(40, Math.max(1, parseInt(req.query.limit || '12', 10) || 12));
  const category = req.query.category || null;
  const cursor = req.query.cursor || null;
  const key = `list:${category || 'all'}:${cursor || ''}:${limit}`;
  const cached = await cacheGet(key);
  if (cached) return res.json(cached);
  const q = { status: 'active', ...(category ? { category } : {}), ...(cursor ? { _id: { $gt: cursor } } : {}) };
  const docs = await Product.find(q).sort({ _id: 1 }).limit(limit + 1).lean();
  const hasMore = docs.length > limit;
  const items = docs.slice(0, limit).map(dto);
  const body = { items, nextCursor: hasMore ? items[items.length - 1].productId : null };
  await cacheSet(key, body, 30);
  res.json(body);
}));

app.get('/v1/products/:id', asyncH(async (req, res) => {
  const key = `one:${req.params.id}`;
  const cached = await cacheGet(key);
  if (cached) return res.json(cached);
  const p = await Product.findById(req.params.id).lean();
  if (!p) throw new HttpError(404, 'NOT_FOUND', 'Product not found');
  const body = { product: dto(p) };
  await cacheSet(key, body, 30);
  res.json(body);
}));

app.get('/v1/categories', asyncH(async (_req, res) => {
  const counts = await Product.aggregate([{ $match: { status: 'active' } }, { $group: { _id: '$category', count: { $sum: 1 } } }]);
  const countMap = Object.fromEntries(counts.map((c) => [c._id, c.count]));
  res.json({ categories: CATEGORIES.map((c) => ({ name: c, count: countMap[c] || 0 })) });
}));

// Internal endpoints
app.get('/internal/products', asyncH(async (req, res) => {
  if (req.query.skus) {
    const skus = String(req.query.skus).split(',').filter(Boolean).slice(0, 100);
    const docs = await Product.find({ sku: { $in: skus } }).lean();
    return res.json({ products: docs.map(dto) });
  }
  if (req.query.all === '1') {
    const cursor = req.query.cursor || null;
    const docs = await Product.find(cursor ? { _id: { $gt: cursor } } : {}).sort({ _id: 1 }).limit(101).lean();
    const hasMore = docs.length > 100;
    const items = docs.slice(0, 100).map(dto);
    return res.json({ items, nextCursor: hasMore ? items[items.length - 1].productId : null });
  }
  throw new HttpError(400, 'BAD_QUERY', 'Provide ?skus=a,b or ?all=1');
}));

// ---- Admin -------------------------------------------------------------------
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
  const count = await Product.countDocuments();
  const id = 'p_' + String(count + 1).padStart(4, '0');
  const catCode = (data.category.replace(/[^A-Za-z]/g, '').slice(0, 4) || 'GEN').toUpperCase();
  const sku = data.sku || `BZ-${catCode}-${String(count + 1).padStart(4, '0')}`;
  const result = await withTxn(async (session) => {
    const [product] = await Product.create([{ _id: id, sku, title: data.title, brand: data.brand, category: data.category, description: data.description, price: data.price, currency: 'INR', emoji: data.emoji, color: data.color, status: data.status, version: 1 }], { session });
    await Audit.create([{ productId: id, sku, adminId: req.user.id, reason: data.reason, changes: { created: data } }], { session });
    await addOutbox(session, { eventType: 'ProductChanged.v1', producer: 'catalog', aggregateId: id, correlationId: req.correlationId, payload: { productId: id, sku, title: data.title, brand: data.brand, category: data.category, description: data.description, price: data.price, emoji: data.emoji, color: data.color, status: data.status, version: 1, initialStock: 50 } });
    return product;
  });
  await cacheInvalidate();
  res.status(201).json({ product: dto(result.result) });
}));

app.put('/v1/admin/products/:id', requireAdmin, asyncH(async (req, res) => {
  const data = validate(updateSchema, req.body);
  const { expectedVersion, reason, ...changes } = data;
  const result = await withTxn(async (session) => {
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, version: expectedVersion },
      { $set: { ...changes, version: expectedVersion + 1 } },
      { new: true, session }
    );
    if (!product) {
      const exists = await Product.findById(req.params.id).session(session);
      throw new TxnAbort(exists ? { conflict: true, currentVersion: exists.version } : null);
    }
    await Audit.create([{ productId: product._id, sku: product.sku, adminId: req.user.id, reason, changes }], { session });
    await addOutbox(session, { eventType: 'ProductChanged.v1', producer: 'catalog', aggregateId: product._id, correlationId: req.correlationId, payload: { ...dto(product), productId: product._id, initialStock: undefined } });
    return product;
  });
  if (result.aborted) {
    if (result.result?.conflict) throw new HttpError(409, 'VERSION_CONFLICT', 'Product was modified by someone else', { currentVersion: result.result.currentVersion });
    throw new HttpError(404, 'NOT_FOUND', 'Product not found');
  }
  await cacheInvalidate();
  res.json({ product: dto(result.result) });
}));

app.get('/v1/admin/audit', requireAdmin, asyncH(async (req, res) => {
  const rows = await Audit.find().sort({ at: -1 }).limit(100).lean();
  res.json({ audit: rows });
}));

// Used by tests: force-list all products including inactive (admin)
app.get('/internal/catalog-dump', asyncH(async (_req, res) => {
  const docs = await Product.find().lean();
  res.json({ products: docs.map(dto) });
}));

async function seed() {
  const count = await Product.countDocuments();
  if (count > 0) return;
  await Product.insertMany(SEED_PRODUCTS);
  logger.info('seeded products', { count: SEED_PRODUCTS.length });
}

(async () => {
  await connectMongo('catalog');
  await amqpConnect().catch(() => {});
  startOutboxRelay('catalog');
  await seed();
  finish(app);
  listen(app, PORT, 'catalog');
})().catch((err) => { logger.error('catalog failed to start', { err: err.message }); process.exit(1); });
