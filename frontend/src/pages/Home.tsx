import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Product } from '../api';
import ProductTile from '../components/ProductTile';

const CATEGORY_ART: Record<string, string> = {
  Electronics: '🎧', Books: '📚', 'Home & Kitchen': '🍳', Fashion: '👕', 'Toys & Games': '🧸', 'Sports & Fitness': '🏋️',
};

export default function Home() {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<{ name: string; count: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [p, c] = await Promise.all([
          api.get<{ items: Product[] }>('/v1/products?limit=12'),
          api.get<{ categories: { name: string; count: number }[] }>('/v1/categories'),
        ]);
        setProducts(p.items);
        setCategories(c.categories);
      } catch (e: any) {
        setError(e.message || 'Could not load the storefront');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <>
      <section className="hero" aria-label="Sale banner">
        <h1>Shop smart on <span>Bazaarly</span></h1>
        <p>Electronics · Books · Fashion · Home &amp; Kitchen — up to 40% off this week. Free delivery over ₹499.</p>
        <Link className="hero-cta" to="/c/Electronics">Shop Electronics deals →</Link>
        <div className="hero-badges" aria-hidden="true">
          <span>🚚 Fast delivery</span><span>↩️ 7-day returns</span><span>🔒 Secure payments</span><span>🇮🇳 Made for India</span>
        </div>
      </section>

      <section aria-label="Shop by category">
        <h2 className="section-title">Shop by category</h2>
        <div className="category-tiles">
          {(categories.length ? categories : Object.keys(CATEGORY_ART).map((n) => ({ name: n, count: 0 }))).map((c) => (
            <Link key={c.name} to={`/c/${encodeURIComponent(c.name)}`} className="category-tile">
              <span className="emoji" aria-hidden="true">{CATEGORY_ART[c.name] || '🛍️'}</span>
              <span className="name">{c.name}</span>
              {c.count > 0 && <span className="muted" style={{ fontSize: 11 }}>{c.count} products</span>}
            </Link>
          ))}
        </div>
      </section>

      <section aria-label="Featured products">
        <h2 className="section-title">Today’s featured products</h2>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        {loading ? (
          <div className="product-grid" aria-busy="true" aria-label="Loading products">
            {Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 250 }} />)}
          </div>
        ) : (
          <div className="product-grid">
            {products.map((p) => <ProductTile key={p.productId} product={p} />)}
          </div>
        )}
      </section>
    </>
  );
}
