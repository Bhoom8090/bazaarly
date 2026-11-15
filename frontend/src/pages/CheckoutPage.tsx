import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api, formatPrice, Address, Pricing, CartItem, ApiError } from '../api';
import { useSession } from '../session';

const IDEMPOTENCY_STORAGE_KEY = 'bazaarly:checkout:idempotency-key';

function newKey(): string {
  return 'checkout-' + crypto.randomUUID().replace(/-/g, '') + '-' + Date.now().toString(36);
}

export default function CheckoutPage() {
  const navigate = useNavigate();
  const { session, loading, refreshCartCount } = useSession();
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [items, setItems] = useState<CartItem[]>([]);
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [selectedAddress, setSelectedAddress] = useState('');
  const [scenario, setScenario] = useState<'success' | 'failure' | 'async' | 'timeout'>('success');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [placing, setPlacing] = useState(false);
  const [showNewAddress, setShowNewAddress] = useState(false);
  const [newAddr, setNewAddr] = useState({ name: '', phone: '', line1: '', line2: '', city: '', state: '', pincode: '' });
  const [attempts, setAttempts] = useState(0);
  const idempotencyKey = useMemo(() => {
    let k = sessionStorage.getItem(IDEMPOTENCY_STORAGE_KEY);
    if (!k) { k = newKey(); sessionStorage.setItem(IDEMPOTENCY_STORAGE_KEY, k); }
    return k;
  }, []);

  useEffect(() => {
    if (!session?.authenticated) return;
    Promise.all([
      api.get<{ addresses: Address[] }>('/v1/addresses'),
      api.get<{ items: CartItem[]; pricing: Pricing }>('/v1/cart'),
    ]).then(([a, c]) => {
      setAddresses(a.addresses);
      setSelectedAddress(a.addresses[0]?._id || '');
      setItems(c.items);
      setPricing(c.pricing);
    }).catch((e) => setError(e.message || 'Could not load checkout data'));
  }, [session]);

  async function addAddress(e: FormEvent) {
    e.preventDefault();
    try {
      const res = await api.post<{ addresses: Address[] }>('/v1/addresses', newAddr);
      setAddresses(res.addresses);
      setSelectedAddress(res.addresses[res.addresses.length - 1]._id);
      setShowNewAddress(false);
      setNewAddr({ name: '', phone: '', line1: '', line2: '', city: '', state: '', pincode: '' });
    } catch (e: any) {
      setError(e.details ? `Invalid address: ${JSON.stringify(e.details)}` : e.message);
    }
  }

  async function placeOrder() {
    if (!selectedAddress) { setError('Please select a delivery address'); return; }
    setPlacing(true); setError(''); setMessage('');
    try {
      const res = await api.post<{ order: { _id: string }; pending?: boolean }>('/v1/checkout', { addressId: selectedAddress, paymentScenario: scenario }, { 'Idempotency-Key': idempotencyKey });
      sessionStorage.removeItem(IDEMPOTENCY_STORAGE_KEY);
      await refreshCartCount();
      if (res.pending) setMessage('Order placed — payment is processing. You will be notified when it settles.');
      navigate(`/orders/${res.order._id}?placed=1`);
    } catch (e: any) {
      // Network failure: same Idempotency-Key can be reused safely.
      const isNetwork = e instanceof TypeError || e.message === 'Failed to fetch' || (e instanceof ApiError && e.status >= 500);
      setError(isNetwork ? `Network hiccup — your payment was not lost. Retry with the SAME key (attempt ${attempts + 1}).` : (e.message || 'Order failed'));
      setAttempts((n) => n + 1);
    } finally {
      setPlacing(false);
    }
  }

  if (loading) return <div className="skeleton" style={{ height: 300 }} />;
  if (!session?.authenticated) return <div className="card form-narrow"><h1>Checkout</h1><p>Please <Link to="/login?next=/checkout">sign in</Link> to check out.</p></div>;
  if (items.length === 0 && !error) return <div className="card"><h1>Checkout</h1><p>Your cart is empty. <Link to="/">Shop now</Link></p></div>;

  return (
    <div className="cart-layout">
      <section>
        <h1 className="section-title" style={{ marginTop: 0 }}>Checkout</h1>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        {message && <div className="alert alert-success" role="status">{message}</div>}

        <div className="card" style={{ marginBottom: 12 }}>
          <h2 style={{ fontSize: 16, marginTop: 0 }}>1 · Delivery address</h2>
          <fieldset style={{ border: 0, padding: 0 }}>
            <legend className="sr-only">Select a delivery address</legend>
            {addresses.map((a) => (
              <label key={a._id} style={{ display: 'flex', gap: 10, padding: '8px 10px', border: selectedAddress === a._id ? '2px solid var(--accent)' : '1px solid #d5d9d9', borderRadius: 6, marginBottom: 8, cursor: 'pointer' }}>
                <input type="radio" name="address" checked={selectedAddress === a._id} onChange={() => setSelectedAddress(a._id)} />
                <span><strong>{a.name}</strong> · {a.phone}<br />{a.line1}{a.line2 ? ', ' + a.line2 : ''}<br />{a.city}, {a.state} — {a.pincode}</span>
              </label>
            ))}
            {addresses.length === 0 && <p className="muted">No saved addresses. Add one below.</p>}
          </fieldset>
          <button className="btn btn-secondary" style={{ marginTop: 6 }} onClick={() => setShowNewAddress((v) => !v)}>{showNewAddress ? 'Cancel' : '+ Add a new address'}</button>
          {showNewAddress && (
            <form onSubmit={addAddress} style={{ marginTop: 12 }}>
              {([['name', 'Full name'], ['phone', 'Phone (10 digits)'], ['line1', 'Address line 1'], ['line2', 'Address line 2 (optional)'], ['city', 'City'], ['state', 'State'], ['pincode', 'Pincode (6 digits)']] as const).map(([field, label]) => (
                <div className="form-group" key={field}>
                  <label htmlFor={`addr-${field}`}>{label}</label>
                  <input id={`addr-${field}`} required={field !== 'line2'} value={(newAddr as any)[field]} onChange={(e) => setNewAddr({ ...newAddr, [field]: e.target.value })} pattern={field === 'phone' ? '[0-9]{10}' : field === 'pincode' ? '[0-9]{6}' : undefined} />
                </div>
              ))}
              <button type="submit" className="btn btn-orange">Save address</button>
            </form>
          )}
        </div>

        <div className="card">
          <h2 style={{ fontSize: 16, marginTop: 0 }}>2 · Payment (sandbox)</h2>
          <p className="muted" style={{ fontSize: 13 }}>Bazaarly uses a mock payment provider. No real money moves. Choose a test scenario:</p>
          <fieldset style={{ border: 0, padding: 0 }}>
            <legend className="sr-only">Payment scenario</legend>
            {([
              ['success', '✅ Success — payment authorized immediately'],
              ['failure', '❌ Failure — card declined'],
              ['async', '⏳ Async — authorized after a few seconds (webhook)'],
              ['timeout', '🐢 Timeout — response delayed; reconciled automatically'],
            ] as const).map(([value, label]) => (
              <label key={value} style={{ display: 'flex', gap: 10, padding: '8px 10px', border: scenario === value ? '2px solid var(--accent)' : '1px solid #d5d9d9', borderRadius: 6, marginBottom: 8, cursor: 'pointer' }}>
                <input type="radio" name="scenario" checked={scenario === value} onChange={() => setScenario(value)} /> <span>{label}</span>
              </label>
            ))}
          </fieldset>
        </div>
      </section>

      <aside className="card price-summary" aria-label="Review your order">
        <h2 style={{ fontSize: 16, marginTop: 0 }}>3 · Review &amp; place order</h2>
        {items.map((i) => <div key={i.sku} className="row"><span>{i.quantity} × {i.title.slice(0, 34)}{i.title.length > 34 ? '…' : ''}</span><span>{formatPrice(i.lineTotal)}</span></div>)}
        {pricing && (
          <>
            <div className="row"><span>Shipping</span><span>{pricing.shipping === 0 ? 'FREE' : formatPrice(pricing.shipping)}</span></div>
            <div className="row"><span>Tax (GST 18%, incl.)</span><span>{formatPrice(pricing.tax)}</span></div>
            <div className="row grand"><span>Total</span><span>{formatPrice(pricing.total)}</span></div>
          </>
        )}
        <button className="btn btn-orange btn-block" style={{ fontSize: 16, padding: '12px 18px' }} disabled={placing || !items.length} onClick={placeOrder}>
          {placing ? 'Placing your order…' : `Place your order (₹${pricing ? (pricing.total / 100).toFixed(2) : ''})`}
        </button>
        {attempts > 0 && <button className="btn btn-secondary btn-block" onClick={placeOrder} disabled={placing}>Retry with the SAME key</button>}
        <p className="muted" style={{ fontSize: 11, marginTop: 10 }}>Idempotency-Key: <code>{idempotencyKey.slice(0, 28)}…</code> · Same key + same body never creates a duplicate order.</p>
      </aside>
    </div>
  );
}
