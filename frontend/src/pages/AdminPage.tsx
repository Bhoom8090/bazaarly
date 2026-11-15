import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatPrice, Order, Product } from '../api';
import { useSession } from '../session';

type Tab = 'products' | 'inventory' | 'orders' | 'shipments' | 'system';

interface Balance { sku: string; onHand: number; reserved: number; available: number; version: number }
interface Shipment { _id: string; orderId: string; customerId: string; state: string; updatedAt: string }

export default function AdminPage() {
  const { session, loading } = useSession();
  const [tab, setTab] = useState<Tab>('products');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const [products, setProducts] = useState<Product[]>([]);
  const [inventory, setInventory] = useState<Balance[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [shipments, setShipments] = useState<Shipment[]>([]);

  // New product form
  const [form, setForm] = useState({ title: '', brand: '', category: 'Electronics', price: '', emoji: '🛍️', color: '#37475a', reason: 'New product' });

  useEffect(() => {
    if (!session?.authenticated || session.user?.role !== 'admin') return;
    if (tab === 'products') api.get<{ items: Product[] }>('/v1/products?limit=40').then((r) => setProducts(r.items)).catch((e) => setError(e.message));
    if (tab === 'inventory') api.get<{ inventory: Balance[] }>('/v1/admin/inventory').then((r) => setInventory(r.inventory)).catch((e) => setError(e.message));
    if (tab === 'orders') api.get<{ orders: Order[] }>('/v1/admin/orders').then((r) => setOrders(r.orders)).catch((e) => setError(e.message));
    if (tab === 'shipments') api.get<{ shipments: Shipment[] }>('/v1/admin/shipments').then((r) => setShipments(r.shipments)).catch((e) => setError(e.message));
  }, [tab, session]);

  if (loading) return <div className="skeleton" style={{ height: 200 }} />;
  if (!session?.authenticated || session.user?.role !== 'admin') {
    return <div className="card form-narrow"><h1>Admin</h1><p>Admins only. <Link to="/login">Sign in with an admin account</Link>.</p></div>;
  }

  async function createProduct(e: FormEvent) {
    e.preventDefault(); setError(''); setMsg('');
    try {
      await api.post('/v1/admin/products', { ...form, price: Math.round(parseFloat(form.price) * 100) });
      setMsg('Product created. Search index will update within a second.');
      setForm({ title: '', brand: '', category: 'Electronics', price: '', emoji: '🛍️', color: '#37475a', reason: 'New product' });
    } catch (e: any) { setError(e.message); }
  }

  async function adjust(sku: string) {
    const deltaStr = window.prompt(`Adjust stock for ${sku} (negative to reduce):`);
    if (!deltaStr) return;
    const delta = parseInt(deltaStr, 10);
    if (Number.isNaN(delta)) return;
    const reason = window.prompt('Reason (min 3 chars):') || '';
    const confirmLarge = Math.abs(delta) > 100 ? window.confirm('|delta| > 100 — confirm large adjustment?') : true;
    try {
      await api.post('/v1/admin/inventory-adjustments', { sku, delta, reason, confirmLarge });
      setMsg(`Adjusted ${sku} by ${delta}`);
      api.get<{ inventory: Balance[] }>('/v1/admin/inventory').then((r) => setInventory(r.inventory));
    } catch (e: any) { setError(e.message); }
  }

  async function addShipmentEvent(orderId: string) {
    const status = window.prompt('New status: LABELLED | IN_TRANSIT | OUT_FOR_DELIVERY | DELIVERED | EXCEPTION | RETURNED');
    if (!status) return;
    try {
      await api.post(`/v1/admin/shipments/${orderId}/events`, { status, note: 'Updated from admin console' });
      setMsg(`Shipment ${orderId} → ${status}`);
      api.get<{ shipments: Shipment[] }>('/v1/admin/shipments').then((r) => setShipments(r.shipments));
    } catch (e: any) { setError(e.message); }
  }

  async function reindex() {
    setError(''); setMsg('');
    try {
      const r = await api.post<{ reindexed: number }>('/v1/admin/search/reindex');
      setMsg(`Search reindexed: ${r.reindexed} products.`);
    } catch (e: any) { setError(e.message); }
  }

  return (
    <>
      <h1 className="section-title">Admin Console</h1>
      {msg && <div className="alert alert-success" role="status">{msg}</div>}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <div className="admin-tabs" role="tablist" aria-label="Admin sections">
        {(['products', 'inventory', 'orders', 'shipments', 'system'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`admin-tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
        ))}
      </div>

      {tab === 'products' && (
        <div className="cart-layout">
          <div className="card">
            <h2 style={{ fontSize: 16, marginTop: 0 }}>Products ({products.length} shown)</h2>
            <table className="admin">
              <thead><tr><th>ID</th><th>Title</th><th>Category</th><th>Price</th><th>Version</th></tr></thead>
              <tbody>{products.map((p) => <tr key={p.productId}><td>{p.productId}</td><td>{p.emoji} {p.title}</td><td>{p.category}</td><td>{formatPrice(p.price)}</td><td>{p.version}</td></tr>)}</tbody>
            </table>
          </div>
          <form className="card" onSubmit={createProduct} aria-label="Create product">
            <h2 style={{ fontSize: 16, marginTop: 0 }}>Add product</h2>
            {([['title', 'Title'], ['brand', 'Brand']] as const).map(([f, label]) => <div className="form-group" key={f}><label htmlFor={`f-${f}`}>{label}</label><input id={`f-${f}`} required value={(form as any)[f]} onChange={(e) => setForm({ ...form, [f]: e.target.value })} /></div>)}
            <div className="form-group"><label htmlFor="f-category">Category</label>
              <select id="f-category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {['Electronics', 'Books', 'Home & Kitchen', 'Fashion', 'Toys & Games', 'Sports & Fitness'].map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div className="form-group"><label htmlFor="f-price">Price (₹)</label><input id="f-price" required type="number" min="1" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></div>
            <div className="form-group"><label htmlFor="f-emoji">Emoji</label><input id="f-emoji" maxLength={4} value={form.emoji} onChange={(e) => setForm({ ...form, emoji: e.target.value })} /></div>
            <div className="form-group"><label htmlFor="f-reason">Reason (audit)</label><input id="f-reason" required minLength={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></div>
            <button className="btn btn-yellow btn-block" type="submit">Create product</button>
          </form>
        </div>
      )}

      {tab === 'inventory' && (
        <div className="card">
          <h2 style={{ fontSize: 16, marginTop: 0 }}>Inventory balances</h2>
          <table className="admin">
            <thead><tr><th>SKU</th><th>On hand</th><th>Reserved</th><th>Available</th><th></th></tr></thead>
            <tbody>{inventory.map((b) => <tr key={b.sku}><td>{b.sku}</td><td>{b.onHand}</td><td>{b.reserved}</td><td>{b.available <= 5 ? <strong style={{ color: '#b12704' }}>{b.available}</strong> : b.available}</td><td><button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => adjust(b.sku)}>Adjust</button></td></tr>)}</tbody>
          </table>
        </div>
      )}

      {tab === 'orders' && (
        <div className="card">
          <h2 style={{ fontSize: 16, marginTop: 0 }}>Orders</h2>
          <table className="admin">
            <thead><tr><th>Order</th><th>Total</th><th>State</th><th>Placed</th><th></th></tr></thead>
            <tbody>{orders.map((o) => <tr key={o._id}><td>{o._id}</td><td>{formatPrice(o.pricing?.total || 0)}</td><td>{o.state}</td><td>{new Date(o.createdAt).toLocaleString('en-IN')}</td><td><Link to={`/orders/${o._id}`}>View</Link></td></tr>)}</tbody>
          </table>
        </div>
      )}

      {tab === 'shipments' && (
        <div className="card">
          <h2 style={{ fontSize: 16, marginTop: 0 }}>Shipments</h2>
          <table className="admin">
            <thead><tr><th>Shipment</th><th>Order</th><th>State</th><th>Updated</th><th></th></tr></thead>
            <tbody>{shipments.map((s) => <tr key={s._id}><td>{s._id}</td><td>{s.orderId}</td><td>{s.state}</td><td>{new Date(s.updatedAt).toLocaleString('en-IN')}</td><td><button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => addShipmentEvent(s.orderId)}>Advance</button></td></tr>)}</tbody>
          </table>
          <p className="muted" style={{ fontSize: 12 }}>Lifecycle: CREATED → LABELLED → IN_TRANSIT → OUT_FOR_DELIVERY → DELIVERED.</p>
        </div>
      )}

      {tab === 'system' && (
        <div className="card">
          <h2 style={{ fontSize: 16, marginTop: 0 }}>System</h2>
          <ul>
            <li>API docs: <a href="http://localhost:8080/api-docs" target="_blank" rel="noreferrer">http://localhost:8080/api-docs</a></li>
            <li>Prometheus: <a href="http://localhost:9090" target="_blank" rel="noreferrer">http://localhost:9090</a></li>
            <li>Grafana: <a href="http://localhost:3001" target="_blank" rel="noreferrer">http://localhost:3001</a> (admin/admin)</li>
            <li>RabbitMQ: <a href="http://localhost:15672" target="_blank" rel="noreferrer">http://localhost:15672</a> (guest/guest) — inspect <code>commerce.dlq</code></li>
            <li>Mailpit: <a href="http://localhost:8025" target="_blank" rel="noreferrer">http://localhost:8025</a> — captured notification emails</li>
          </ul>
          <button className="btn btn-orange" onClick={reindex}>Rebuild search index</button>
        </div>
      )}
    </>
  );
}
