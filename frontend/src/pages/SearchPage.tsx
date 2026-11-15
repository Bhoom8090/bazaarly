import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, Product } from '../api';
import ProductTile from '../components/ProductTile';

export default function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') || '';
  const category = searchParams.get('category') || '';
  const sort = searchParams.get('sort') || 'relevance';
  const minPrice = searchParams.get('minPrice') || '';
  const maxPrice = searchParams.get('maxPrice') || '';

  const [items, setItems] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<{ name: string; count: number }[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const run = useCallback(async (append: boolean) => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (category) params.set('category', category);
      if (sort) params.set('sort', sort);
      if (minPrice) params.set('minPrice', String(Math.round(parseFloat(minPrice) * 100)));
      if (maxPrice) params.set('maxPrice', String(Math.round(parseFloat(maxPrice) * 100)));
      params.set('limit', '20');
      if (append && nextCursor) params.set('cursor', nextCursor);
      const res = await api.get<{ items: Product[]; total: number; facets: { categories: { name: string; count: number }[] }; nextCursor: string | null }>(`/v1/search?${params}`);
      setItems((prev) => (append ? [...prev, ...res.items] : res.items));
      setTotal(res.total);
      setFacets(res.facets?.categories || []);
      setNextCursor(res.nextCursor);
    } catch (e: any) {
      setError(e.message || 'Search failed');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, category, sort, minPrice, maxPrice]);

  useEffect(() => { setItems([]); setNextCursor(null); run(false); }, [run]);

  function updateParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    next.delete('cursor');
    setSearchParams(next);
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '230px 1fr', gap: 16, alignItems: 'start' }}>
      <aside className="card" aria-label="Filters">
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Filters</h2>
        <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
          <legend className="muted" style={{ fontSize: 13, marginBottom: 6 }}>Category</legend>
          <label style={{ display: 'flex', gap: 8, fontSize: 13, padding: '3px 0' }}><input type="radio" name="facet" checked={!category} onChange={() => updateParam('category', '')} /> All</label>
          {facets.map((f) => (
            <label key={f.name} style={{ display: 'flex', gap: 8, fontSize: 13, padding: '3px 0' }}>
              <input type="radio" name="facet" checked={category === f.name} onChange={() => updateParam('category', f.name)} /> {f.name} <span className="muted">({f.count})</span>
            </label>
          ))}
        </fieldset>
        <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
          <legend className="muted" style={{ fontSize: 13, marginBottom: 6 }}>Price (₹)</legend>
          <label className="sr-only" htmlFor="minp">Min price</label>
          <input id="minp" type="number" min={0} placeholder="Min" defaultValue={minPrice} onBlur={(e) => updateParam('minPrice', e.target.value)} style={{ width: '48%', padding: 6, marginRight: '4%' }} />
          <label className="sr-only" htmlFor="maxp">Max price</label>
          <input id="maxp" type="number" min={0} placeholder="Max" defaultValue={maxPrice} onBlur={(e) => updateParam('maxPrice', e.target.value)} style={{ width: '48%', padding: 6 }} />
        </fieldset>
        <label htmlFor="sort" style={{ fontSize: 13 }}>Sort by</label>
        <select id="sort" value={sort} onChange={(e) => updateParam('sort', e.target.value)} style={{ width: '100%', padding: 8, marginTop: 4 }}>
          <option value="relevance">Relevance</option>
          <option value="price_asc">Price: Low to High</option>
          <option value="price_desc">Price: High to Low</option>
        </select>
      </aside>
      <section aria-label="Search results">
        <h1 className="section-title" style={{ marginTop: 0 }}>{q ? <>Results for “{q}”</> : 'All products'} <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>({total})</span></h1>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <div className="product-grid">
          {items.map((p) => <ProductTile key={p.productId} product={p} />)}
        </div>
        {items.length === 0 && !loading && <p className="muted">No results. Try a different keyword.</p>}
        <div style={{ textAlign: 'center', margin: '18px 0' }}>
          {nextCursor && <button className="btn btn-secondary" disabled={loading} onClick={() => run(true)}>{loading ? 'Loading…' : 'Load more'}</button>}
        </div>
      </section>
    </div>
  );
}
