import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatPrice, Order } from '../api';
import { useSession } from '../session';

const STATE_CLASS: Record<string, string> = { CONFIRMED: 'badge-ok', DELIVERED: 'badge-ok', SHIPPED: 'badge-ok', FULFILLING: 'badge-state', PENDING_VALIDATION: 'badge-warn', PAYMENT_PENDING: 'badge-warn', PAYMENT_FAILED: 'badge-bad', CANCELLED: 'badge-bad', EXPIRED: 'badge-bad' };

export default function OrdersPage() {
  const { session, loading } = useSession();
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!session?.authenticated) return;
    api.get<{ orders: Order[] }>('/v1/orders').then((r) => setOrders(r.orders)).catch((e) => setError(e.message));
  }, [session]);

  if (loading) return <div className="skeleton" style={{ height: 200 }} />;
  if (!session?.authenticated) return <div className="card form-narrow"><h1>Your orders</h1><p>Please <Link to="/login?next=/orders">sign in</Link> to see your orders.</p></div>;

  return (
    <>
      <h1 className="section-title">Your Orders</h1>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {orders.length === 0 ? (
        <div className="card"><p>No orders yet. <Link to="/">Start shopping</Link></p></div>
      ) : orders.map((o) => (
        <div key={o._id} className="card" style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div className="muted" style={{ fontSize: 12 }}>ORDER PLACED {new Date(o.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
            <h2 style={{ fontSize: 16, margin: '4px 0' }}><Link to={`/orders/${o._id}`} style={{ color: 'var(--link)', textDecoration: 'none' }}>Order #{o._id}</Link></h2>
            <div className="muted" style={{ fontSize: 12 }}>{o.items.length} item{o.items.length > 1 ? 's' : ''} · {formatPrice(o.pricing.total)}</div>
          </div>
          <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
            <span className={`badge ${STATE_CLASS[o.state] || 'badge-state'}`}>{o.state.replace(/_/g, ' ')}</span>
            <Link className="btn btn-secondary" to={`/orders/${o._id}`} style={{ padding: '6px 14px' }}>Track package</Link>
          </div>
        </div>
      ))}
    </>
  );
}
