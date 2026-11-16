'use strict';
// Search service: read-optimised projection of the catalog, kept fresh via
// ProductChanged.v1 events. Rebuildable from the catalog at any time.
const { z } = require('zod');
const config = require('../../shared/config');
const logger = require('../../shared/logger');
const { createApp, finish, listen, asyncH, validate, requireAdmin, HttpError } = require('../../shared/http');
const { connectMongo, mongoose } = require('../../shared/db');
const { consume, amqpConnect } = require('../../shared/events');
const { callService } = require('../../shared/clients');

const app = createApp('search');
const PORT = parseInt(process.env.PORT || '4003', 10);

const docSchema = new mongoose.Schema({
  _id: String, // productId
  sku: { type: String, index: true },
  title: String,
  brand: String,
  category: { type: String, index: true },
  description: String,
  price: Number,
  emoji: String,
  color: String,
  status: String,
  version: { type: Number, default: 0 },
}, { collection: 'search_docs', versionKey: false, _id: false });
docSchema.index({ title: 'text', description: 'text', brand: 'text', category: 'text' });
const Doc = mongoose.model('SearchDoc', docSchema);

async function applyProductChanged(p) {
  // Version-guarded upsert: ignore stale events.
  if (!p || !p.productId) return;
  const existing = await Doc.findById(p.productId).lean();
  if (existing && (existing.version || 0) >= (p.version || 0)) return;
  if (p.status === 'inactive') {
    await Doc.deleteOne({ _id: p.productId });
    return;
  }
  await Doc.findByIdAndUpdate(p.productId, {
    $set: { sku: p.sku, title: p.title, brand: p.brand, category: p.category, description: p.description || '', price: p.price, emoji: p.emoji, color: p.color, status: p.status || 'active', version: p.version || 1 },
  }, { upsert: true });
}

const searchSchema = z.object({
  q: z.string().max(100).optional().default(''),
  category: z.string().max(60).optional(),
  minPrice: z.coerce.number().int().nonnegative().optional(),
  maxPrice: z.coerce.number().int().nonnegative().optional(),
  sort: z.enum(['relevance', 'price_asc', 'price_desc']).optional().default('relevance'),
  cursor: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(40).optional().default(20),
});

app.get('/v1/search', asyncH(async (req, res) => {
  const { q, category, minPrice, maxPrice, sort, cursor, limit } = validate(searchSchema, req.query);
  const filter = { status: 'active' };
  if (category) filter.category = category;
  if (minPrice != null) filter.price = { ...(filter.price || {}), $gte: minPrice };
  if (maxPrice != null) filter.price = { ...(filter.price || {}), $lte: maxPrice };

  let usedText = false;
  if (q && q.trim()) { filter.$text = { $search: q.trim() }; usedText = true; }

  let sortSpec = sort === 'price_asc' ? { price: 1, _id: 1 } : sort === 'price_desc' ? { price: -1, _id: 1 } : usedText ? { score: { $meta: 'textScore' }, _id: 1 } : { _id: 1 };
  let projection = usedText && sort === 'relevance' ? { score: { $meta: 'textScore' } } : {};

  const runQuery = async (f) => {
    let query = Doc.find(f, projection).sort(sortSpec);
    if (cursor) query = query.where('_id').gt(cursor);
    return query.limit(limit + 1).lean();
  };

  let docs = await runQuery(filter);
  // Regex fallback when $text finds nothing — drop textScore sort/projection too
  if (usedText && docs.length === 0 && q.trim()) {
    delete filter.$text;
    sortSpec = sort === 'price_asc' ? { price: 1, _id: 1 } : sort === 'price_desc' ? { price: -1, _id: 1 } : { _id: 1 };
    projection = {};
    const rx = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ title: rx }, { description: rx }, { brand: rx }, { sku: rx }];
    docs = await runQuery(filter);
  }

  const total = await Doc.countDocuments(usedText && filter.$text ? filter : (() => { const f = { ...filter }; return f; })());
  const facetAgg = await Doc.aggregate([{ $match: { status: 'active', ...(minPrice != null || maxPrice != null ? { price: filter.price } : {}) } }, { $group: { _id: '$category', count: { $sum: 1 } } }]);
  const hasMore = docs.length > limit;
  const items = docs.slice(0, limit).map((d) => ({ productId: d._id, sku: d.sku, title: d.title, brand: d.brand, category: d.category, price: d.price, emoji: d.emoji, color: d.color }));
  res.json({
    items,
    total,
    facets: { categories: facetAgg.map((f) => ({ name: f._id, count: f.count })) },
    nextCursor: hasMore ? items[items.length - 1].productId : null,
    query: q.trim(),
  });
}));

// Admin: rebuild projection from catalog
async function reindex() {
  logger.info('search reindex started');
  await Doc.deleteMany({});
  let cursor = null;
  let total = 0;
  do {
    const qs = cursor ? `?all=1&cursor=${encodeURIComponent(cursor)}` : '?all=1';
    const res = await callService(config.services.catalog, `/internal/products${qs}`, { timeoutMs: 10000, retries: 3 });
    if (!res.ok) throw new Error('catalog reindex fetch failed: ' + res.status);
    for (const p of res.data.items || []) {
      await applyProductChanged({ ...p, productId: p.productId, version: p.version || 1 });
      total++;
    }
    cursor = res.data.nextCursor;
  } while (cursor);
  logger.info('search reindex complete', { total });
  return total;
}

app.post('/v1/admin/search/reindex', requireAdmin, asyncH(async (_req, res) => {
  const total = await reindex();
  res.json({ reindexed: total });
}));

(async () => {
  await connectMongo('search');
  await amqpConnect().catch(() => {});
  await consume('search.product-changed', async (envl) => { await applyProductChanged(envl.payload); });
  // Rebuildable read model: reindex from catalog on boot (best effort).
  reindex().catch((e) => logger.warn('boot reindex failed (will rely on events)', { err: e.message }));
  finish(app);
  listen(app, PORT, 'search');
})().catch((err) => { logger.error('search failed to start', { err: err.message }); process.exit(1); });
