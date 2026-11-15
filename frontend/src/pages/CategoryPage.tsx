import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { api, Product } from '../api';
import ProductTile from '../components/ProductTile';

export default function CategoryPage() {
  const { category = '' } = useParams();
  const decoded = decodeURIComponent(category);
  const [items, setItems] = useState<Product[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (append: boolean) => {
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams({ category: decoded, limit: '12', ...(append && cursor ? { cursor } : {}) });
      const res = await api.get<{ items: Product[]; nextCursor: string | null }>(`/v1/products?${qs}`);
      setItems((prev) => (append ? [...prev, ...res.items] : res.items));
      setCursor(res.nextCursor);
    } catch (e: any) {
      setError(e.message || 'Could not load products');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decoded]);

  useEffect(() => { setItems([]); setCursor(null); load(false); }, [decoded, load]);

  return (
    <>
      <h1 className="section-title">{decoded}</h1>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <div className="product-grid">
        {items.map((p) => <ProductTile key={p.productId} product={p} />)}
      </div>
      {items.length === 0 && !loading && !error && <p className="muted">No products in this category yet.</p>}
      <div style={{ textAlign: 'center', margin: '18px 0' }}>
        {cursor && <button className="btn btn-secondary" onClick={() => load(true)} disabled={loading}>{loading ? 'Loading…' : 'Load more'}</button>}
      </div>
    </>
  );
}
