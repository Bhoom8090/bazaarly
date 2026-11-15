import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, formatPrice, Pricing, CartItem } from '../api';
import { useSession } from '../session';

export default function CartPage() {
  const navigate = useNavigate();
  const { session, loading, refreshCartCount } = useSession();
  const [items, setItems] = useState<CartItem[]>([]);
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ items: CartItem[]; pricing: Pricing }>('/v1/cart');
      setItems(res.items);
      setPricing(res.pricing);
    } catch (e: any) {
      setError(e.message || 'Could not load cart');
    }
  }, []);

  useEffect(() => { if (session?.authenticated) load(); }, [session, load]);

  async function setQty(sku: string, quantity: number) {
    setBusy(true); setError('');
    try {
      const res = await api.put<{ items: CartItem[]; pricing: Pricing }>(`/v1/cart/items/${encodeURIComponent(sku)}`, { quantity });
      setItems(res.items); setPricing(res.pricing);
      await refreshCartCount();
    } catch (e: any) {
      setError(e.message || 'Could not update cart');
    } finally { setBusy(false); }
  }

  if (loading) return <div className="skeleton" style={{ height: 200 }} />;
  if (!session?.authenticated) return (
    <div className="card form-narrow"><h1>Your cart</h1><p>Please <Link to="/login">sign in</Link> to view your cart.</p></div>
  );

  return (
    <div className="cart-layout">
      <section className="card" aria-label="Cart items">
        <h1 style={{ marginTop: 0 }}>Shopping Cart</h1>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        {items.length === 0 ? (
          <p>Your Bazaarly cart is empty. <Link to="/">Continue shopping</Link></p>
        ) : items.map((item) => (
          <div key={item.sku} className="cart-row">
            <div aria-hidden="true" style={{ fontSize: 52, textAlign: 'center' }}>{item.emoji}</div>
            <div>
              <Link to={`/p/${item.productId}`} style={{ color: 'var(--link)', textDecoration: 'none' }}>{item.title}</Link>
              <div className="price" style={{ fontSize: 16 }}>{formatPrice(item.unitPrice)}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <button className="qty-btn" aria-label="Decrease quantity" disabled={busy} onClick={() => setQty(item.sku, item.quantity - 1)}>−</button>
                <span aria-live="polite" aria-label={`Quantity ${item.quantity}`}>{item.quantity}</span>
                <button className="qty-btn" aria-label="Increase quantity" disabled={busy || item.quantity >= 10} onClick={() => setQty(item.sku, item.quantity + 1)}>+</button>
                <button className="linkish" style={{ background: 'none', border: 0, color: 'var(--link)', cursor: 'pointer', marginLeft: 8 }} onClick={() => setQty(item.sku, 0)}>Delete</button>
              </div>
            </div>
            <div className="price">{formatPrice(item.lineTotal)}</div>
          </div>
        ))}
        {items.length > 0 && <p style={{ textAlign: 'right', marginBottom: 0 }}>Subtotal ({items.length} item{items.length > 1 ? 's' : ''}): <strong className="price">{pricing ? formatPrice(pricing.subtotal) : ''}</strong></p>}
      </section>
      {pricing && pricing.total > 0 && (
        <aside className="card price-summary" aria-label="Order summary">
          <h2 style={{ fontSize: 17, marginTop: 0 }}>Order Summary</h2>
          <div className="row"><span>Subtotal</span><span>{formatPrice(pricing.subtotal)}</span></div>
          <div className="row"><span>Shipping</span><span>{pricing.shipping === 0 ? <span className="free">FREE</span> : formatPrice(pricing.shipping)}</span></div>
          <div className="row"><span>Tax (GST 18%, incl.)</span><span>{formatPrice(pricing.tax)}</span></div>
          <div className="row grand"><span>Order total</span><span>{formatPrice(pricing.total)}</span></div>
          {pricing.shipping > 0 && <p className="muted" style={{ fontSize: 12 }}>Add {formatPrice(pricing.freeShippingThreshold - pricing.subtotal)} more for FREE delivery.</p>}
          <button className="btn btn-yellow btn-block" onClick={() => navigate('/checkout')}>Proceed to Buy</button>
        </aside>
      )}
    </div>
  );
}
