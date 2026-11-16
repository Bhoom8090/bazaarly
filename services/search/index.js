'use strict';
// Search service: read-optimised projection of the catalog, kept fresh via
// ProductChanged.v1 events. Rebuildable from the catalog at any time.
require('../../shared/telemetry');
const { z } = require('zod');
const config = require('../../shared/config');
const logger = require('../../shared/logger');
const { createApp, finish, listen, asyncH, validate, requireAdmin, HttpError } = require('../../shared/http');
const { connectDb, ensureEventTables } = require('../../shared/db');
const { consume, amqpConnect } = require('../../shared/events');
const { callService } = require('../../shared/clients');

const app = createApp('search');
const PORT = parseInt(process.env.PORT || '4003', 10);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS search_docs (
  product_id   TEXT PRIMARY KEY,
  sku          TEXT UNIQUE NOT NULL,
  title        TEXT NOT NULL,
  brand        TEXT NOT NULL,
  category     TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  price        BIGINT NOT NULL,
  emoji        TEXT,
  color        TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  version      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS search_docs_category_idx ON search_docs (category, status);
CREATE INDEX IF NOT EXISTS search_docs_price_idx ON search_docs (status, price);
CREATE INDEX IF NOT EXISTS search_docs_title_idx ON search_docs USING gin(to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'') || ' ' || coalesce(brand,'')));
`;

let pool = null;

const dtoRow = (r) => ({ productId: r.product_id, sku: r.sku, title: r.title, brand: r.brand, category: r.category, description: r.description, price: Number(r.price), emoji: r.emoji, color: r.color, status: r.status, version: r.version });

async function applyProductChanged(p) {
  if (!p || !p.productId) return;
  const cur = await pool.query('SELECT version FROM search_docs WHERE product_id = $1', [p.productId]);
  if (cur.rows.length && (cur.rows[0].version || 0) >= (p.version || 0)) return;
  if (p.status === 'inactive') {
    await pool.query('DELETE FROM search_docs WHERE product_id = $1', [p.productId]);
    return;
  }
  await pool.query(
    `INSERT INTO search_docs (product_id, sku, title, brand, category, description, price, emoji, color, status, version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (product_id) DO UPDATE SET
       sku=EXCLUDED.sku, title=EXCLUDED.title, brand=EXCLUDED.brand, category=EXCLUDED.category,
       description=EXCLUDED.description, price=EXCLUDED.price, emoji=EXCLUDED.emoji,
       color=EXCLUDED.color, status=EXCLUDED.status, version=EXCLUDED.version`,
    [p.productId, p.sku, p.title, p.brand, p.category, p.description || '', p.price, p.emoji, p.color, p.status || 'active', p.version || 1]
  );
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
  const params = ['active'];
  const where = ['status = $1'];
  if (category) { params.push(category); where.push(`category = $${params.length}`); }
  if (minPrice != null) { params.push(minPrice); where.push(`price >= $${params.length}`); }
  if (maxPrice != null) { params.push(maxPrice); where.push(`price <= $${params.length}`); }

  const trimmed = q.trim();
  let useText = sort === 'relevance' && trimmed.length > 0;
  if (useText) {
    params.push(trimmed);
    where.push(`to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'') || ' ' || coalesce(brand,'')) @@ plainto_tsquery('english', $${params.length})`);
  } else if (trimmed.length > 0) {
    const rx = '%' + trimmed.replace(/[%_\\]/g, (m) => '\\' + m) + '%';
    params.push(rx);
    where.push(`(title ILIKE $${params.length} OR description ILIKE $${params.length} OR brand ILIKE $${params.length} OR sku ILIKE $${params.length})`);
  }

  // Sort + cursor: stable pagination by product_id whenever a cursor is present.
  let orderBy = 'product_id';
  if (!cursor) {
    if (sort === 'price_asc') orderBy = 'price ASC, product_id ASC';
    else if (sort === 'price_desc') orderBy = 'price DESC, product_id ASC';
    else if (useText) orderBy = `ts_rank(to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'') || ' ' || coalesce(brand,'')), plainto_tsquery('english', $${params.length})) DESC, product_id ASC`;
  }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  if (cursor) { params.push(cursor); }
  params.push(limit + 1);
  const r = await pool.query(`SELECT * FROM search_docs ${whereSql}${cursor ? ' AND product_id > $' + (params.length - 1) : ''} ORDER BY ${orderBy} LIMIT $${params.length}`, params);
  let rows = r.rows;

  // Partial/typo words: $text matched nothing -> ILIKE substring search
  if (useText && rows.length === 0 && trimmed.length > 0) {
    useText = false;
    const fbParams = ['active'];
    const fbWhere = ['status = $1'];
    if (category) { fbParams.push(category); fbWhere.push(`category = $${fbParams.length}`); }
    if (minPrice != null) { fbParams.push(minPrice); fbWhere.push(`price >= $${fbParams.length}`); }
    if (maxPrice != null) { fbParams.push(maxPrice); fbWhere.push(`price <= $${fbParams.length}`); }
    fbParams.push('%' + trimmed.replace(/[%_\\]/g, (m) => '\\' + m) + '%');
    fbWhere.push(`(title ILIKE $${fbParams.length} OR description ILIKE $${fbParams.length} OR brand ILIKE $${fbParams.length} OR sku ILIKE $${fbParams.length})`);
    if (cursor) { fbParams.push(cursor); fbWhere.push(`product_id > $${fbParams.length}`); }
    fbParams.push(limit + 1);
    const fr = await pool.query(`SELECT * FROM search_docs WHERE ${fbWhere.join(' AND ')} ORDER BY product_id LIMIT $${fbParams.length}`, fbParams);
    rows = fr.rows;
    // Rebuild total to ILIKE semantics
    const totalParams = ['active'];
    const totalWhere = ['status = $1'];
    if (category) { totalParams.push(category); totalWhere.push(`category = $${totalParams.length}`); }
    if (minPrice != null) { totalParams.push(minPrice); totalWhere.push(`price >= $${totalParams.length}`); }
    if (maxPrice != null) { totalParams.push(maxPrice); totalWhere.push(`price <= $${totalParams.length}`); }
    totalParams.push('%' + trimmed.replace(/[%_\\]/g, (m) => '\\' + m) + '%');
    totalWhere.push(`(title ILIKE $${totalParams.length} OR description ILIKE $${totalParams.length} OR brand ILIKE $${totalParams.length} OR sku ILIKE $${totalParams.length})`);
    const tr = await pool.query(`SELECT count(*)::int AS c FROM search_docs WHERE ${totalWhere.join(' AND ')}`, totalParams);
    const facetParams = ['active'];
    const facetWhere = ['status = $1'];
    if (minPrice != null) { facetParams.push(minPrice); facetWhere.push(`price >= $${facetParams.length}`); }
    if (maxPrice != null) { facetParams.push(maxPrice); facetWhere.push(`price <= $${facetParams.length}`); }
    const facetsRes = await pool.query(`SELECT category AS name, count(*)::int AS count FROM search_docs WHERE ${facetWhere.join(' AND ')} GROUP BY category`, facetParams);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(dtoRow);
    return res.json({ items, total: tr.rows[0].c, facets: { categories: facetsRes.rows.map((f) => ({ name: f.name, count: f.count })) }, nextCursor: hasMore ? items[items.length - 1].productId : null, query: trimmed });
  }

  // Total + facet counts (no WHERE for text to keep facets useful)
  const facetWhere = ['status = $1'];
  const facetParams = ['active'];
  if (minPrice != null) { facetParams.push(minPrice); facetWhere.push(`price >= $${facetParams.length}`); }
  if (maxPrice != null) { facetParams.push(maxPrice); facetWhere.push(`price <= $${facetParams.length}`); }
  const facetsRes = await pool.query(`SELECT category AS name, count(*)::int AS count FROM search_docs WHERE ${facetWhere.join(' AND ')} GROUP BY category`, facetParams);

  let totalFilter = ['status = $1'];
  const totalParams = ['active'];
  if (category) { totalParams.push(category); totalFilter.push(`category = $${totalParams.length}`); }
  if (minPrice != null) { totalParams.push(minPrice); totalFilter.push(`price >= $${totalParams.length}`); }
  if (maxPrice != null) { totalParams.push(maxPrice); totalFilter.push(`price <= $${totalParams.length}`); }
  if (useText) {
    totalParams.push(trimmed);
    totalFilter.push(`to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'') || ' ' || coalesce(brand,'')) @@ plainto_tsquery('english', $${totalParams.length})`);
  } else if (trimmed.length > 0) {
    totalParams.push('%' + trimmed.replace(/[%_\\]/g, (m) => '\\' + m) + '%');
    totalFilter.push(`(title ILIKE $${totalParams.length} OR description ILIKE $${totalParams.length} OR brand ILIKE $${totalParams.length} OR sku ILIKE $${totalParams.length})`);
  }
  const totalRes = await pool.query(`SELECT count(*)::int AS c FROM search_docs WHERE ${totalFilter.join(' AND ')}`, totalParams);

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(dtoRow);
  res.json({
    items,
    total: totalRes.rows[0].c,
    facets: { categories: facetsRes.rows.map((f) => ({ name: f.name, count: f.count })) },
    nextCursor: hasMore ? items[items.length - 1].productId : null,
    query: trimmed,
  });
}));

// Admin: rebuild projection from catalog
async function reindex() {
  logger.info('search reindex started');
  await pool.query('DELETE FROM search_docs');
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
  pool = await connectDb('bazaarly_search');
  await pool.query(SCHEMA);
  await ensureEventTables(pool);
  await amqpConnect().catch(() => {});
  await consume('search.product-changed', async (envl) => { await applyProductChanged(envl.payload); }, pool);
  // Rebuildable read model: reindex from catalog on boot (best effort).
  reindex().catch((e) => logger.warn('boot reindex failed (will rely on events)', { err: e.message }));
  finish(app);
  listen(app, PORT, 'search');
})().catch((err) => { logger.error('search failed to start', { err: err.message }); process.exit(1); });
