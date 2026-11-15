import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, formatPrice, Product } from '../api';
import { useSession } from '../session';

type Availability = Record<string, { status: 'IN_STOCK' | 'LOW' | 'OUT_OF_STOCK'; count?: number }>;

export default function ProductPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { session, refreshCartCount } = useSession();
  const [product, setProduct] = useState<Product | null>(null);
  const [availability, setAvailability] = useState<{ status: string; count?: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true); setError('');
    api.get<{ product: Product }>(`/v1/products/${id}`)
      .then(async ({ product }) => {
        setProduct(product);
        try {
          const a = await api.get<{ availability: Availability }>(`/v1/availability?skus=${encodeURIComponent(product.sku)}`);
          setAvailability(a.availability?.[product.sku] || { status: 'OUT_OF_STOCK' });
        } catch { setAvailability(null); }
      })
      .catch((e) => setError(e.message || 'Product not found'))
      .finally(() => setLoading(false));
  }, [id]);

  async function addToCart(thenGoTo?: string) {
    if (!session?.authenticated) { navigate('/login?next=' + encodeURIComponent(`/p/${id}`)); return; }
    if (!product) return;
    setAdding(true); setMessage('');
    try {
      await api.put(`/v1/cart/items/${encodeURIComponent(product.sku)}`, { quantity: 1 });
      await refreshCartCount();
      if (thenGoTo) navigate(thenGoTo);
      else setMessage('Added to cart');
    } catch (e: any) {
      setError(e.message || 'Could not add to cart');
    } finally {
      setAdding(false);
    }
  }

  if (loading) return <div className="skeleton" style={{ height: 380 }} aria-busy="true" aria-label="Loading product" />;
  if (error) return <div className="alert alert-error" role="alert">{error}</div>;
  if (!product) return null;

  const out = availability?.status === 'OUT_OF_STOCK';
  const low = availability?.status === 'LOW';

  return (
    <div className="product-detail">
      <div className="detail-tile" role="img" aria-label={`${product.title} illustration`} style={{ background: `linear-gradient(140deg, ${product.color} 0%, ${product.color} 55%, rgba(255,255,255,.14) 55.2%)` }}>
        {product.emoji}
      </div>
      <div className="card">
        <span className="brand">Visit the {product.brand} Store</span>
        <h1 style={{ fontSize: 24, margin: '4px 0 6px' }}>{product.title}</h1>
        <div className="price" style={{ fontSize: 28 }}><small>₹</small>{formatPrice(product.price).slice(1)}</div>
        <span className="mrp">Inclusive of all taxes · SKU {product.sku}</span>
        <hr className="divider" />
        <h2 style={{ fontSize: 15 }}>About this item</h2>
        <p>{product.description}</p>
        <p className="muted">Category: <a className="link" style={{ color: 'var(--link)' }} href={`#/c/${encodeURIComponent(product.category)}`}>{product.category}</a></p>
      </div>
      <aside className="buy-box" aria-label="Buy box">
        <div className="price" style={{ fontSize: 22 }}><small>₹</small>{formatPrice(product.price).slice(1)}</div>
        <div className="total-note">FREE delivery <strong>Tomorrow</strong>. Details</div>
        {out
          ? <p className="availability out">Currently unavailable</p>
          : low
            ? <p className="availability low">Only {availability?.count} left — order soon</p>
            : <p className="availability in">In stock</p>}
        <button className="btn btn-yellow btn-block" disabled={out || adding} onClick={() => addToCart()}>{adding ? 'Adding…' : 'Add to Cart'}</button>
        <button className="btn btn-orange btn-block" disabled={out || adding} onClick={() => addToCart('/checkout')}>Buy Now</button>
        {message && <p className="alert alert-success" role="status" style={{ margin: 0 }}>{message}</p>}
        <p className="total-note">Sold by <strong>Bazaarly Retail</strong> · 7-day return policy</p>
      </aside>
    </div>
  );
}
