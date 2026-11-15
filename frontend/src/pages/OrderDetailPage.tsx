import { useEffect, useState, useCallback } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { api, formatPrice, Order } from '../api';
import { useSession } from '../session';

const STEPS = ['PENDING_VALIDATION', 'INVENTORY_RESERVED', 'PAYMENT_PENDING', 'CONFIRMED', 'FULFILLING', 'SHIPPED', 'DELIVERED'];
const STEP_LABEL: Record<string, string> = {
  PENDING_VALIDATION: 'Processing', INVENTORY_RESERVED: 'Stock reserved', PAYMENT_PENDING: 'Payment', CONFIRMED: 'Confirmed', FULFILLING: 'Packed', SHIPPED: 'Shipped', DELIVERED: 'Delivered',
};
const TERMINAL_BAD = new Set(['CANCELLED', 'PAYMENT_FAILED', 'EXPIRED']);

interface Tracking { orderId: string; state: string; events: { eventId: string; status: string; note: string; at: string }[] }

export default function OrderDetailPage() {
  const { id = '' } = useParams();
  const [searchParams] = useSearchParams();
  const placed = searchParams.get('placed') === '1';
  const { session, loading } = useSession();
  const [order, setOrder] = useState<Order | null>(null);
  const [tracking, setTracking] = useState<Tracking | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ order: Order }>(`/v1/orders/${id}`);
      setOrder(res.order);
      try {
        const t = await api.get<{ tracking: Tracking }>(`/v1/orders/${id}/tracking`);
        setTracking(t.tracking);
      } catch { /* shipment may not exist yet */ }
    } catch (e: any) {
      setError(e.status === 404 ? 'Order not found (or not yours).' : e.message);
    }
  }, [id]);

  useEffect(() => { if (session?.authenticated) load(); }, [session, load]);

  // Poll every 3s while the order is in a non-terminal pending state
  useEffect(() => {
    if (!order) return;
    const pending = ['PENDING_VALIDATION', 'INVENTORY_RESERVED', 'PAYMENT_PENDING'].includes(order.state);
    if (!pending) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [order, load]);

  if (loading) return <div className="skeleton" style={{ height: 300 }} />;
  if (!session?.authenticated) return <div className="card form-narrow"><h1>Order</h1><p>Please <Link to="/login">sign in</Link>.</p></div>;
  if (error) return <div className="alert alert-error" role="alert">{error} <Link to="/orders">← All orders</Link></div>;
  if (!order) return <div className="skeleton" style={{ height: 300 }} />;

  const bad = TERMINAL_BAD.has(order.state);
  const stepIndex = STEPS.indexOf(order.state);

  return (
    <>
      {placed && <div className="alert alert-success" role="status"><strong>Order placed!</strong> Order {order._id} {order.state === 'CONFIRMED' ? 'is confirmed.' : 'is being processed.'}</div>}
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h1 style={{ margin: '0 0 4px', fontSize: 22 }}>Order details</h1>
            <div className="muted" style={{ fontSize: 12 }}>Order # {order._id} · Placed {new Date(order.createdAt).toLocaleString('en-IN')}</div>
          </div>
          <span className={`badge ${bad ? 'badge-bad' : order.state === 'DELIVERED' ? 'badge-ok' : 'badge-state'}`} style={{ alignSelf: 'start' }}>{order.state.replace(/_/g, ' ')}</span>
        </div>

        {bad ? (
          <p className="alert alert-error" style={{ marginTop: 12 }}>This order was {order.state === 'PAYMENT_FAILED' ? 'not paid (payment declined)' : order.state === 'EXPIRED' ? 'cancelled due to timeout' : 'cancelled'}{order.cancelReason ? ` — reason: ${order.cancelReason}` : ''}. Any authorized amount will be voided automatically.</p>
        ) : (
          <div className="status-tracker" aria-label="Order progress">
            {STEPS.map((s, i) => (
              <div key={s} className={`tracker-step ${stepIndex > i ? 'done' : stepIndex === i ? 'current' : ''}`} aria-current={stepIndex === i ? 'step' : undefined}>{STEP_LABEL[s]}</div>
            ))}
          </div>
        )}
      </div>

      <div className="cart-layout">
        <section className="card" aria-label="Items">
          <h2 style={{ fontSize: 16, marginTop: 0 }}>Items</h2>
          {order.items.map((i) => (
            <div key={i.sku} className="cart-row" style={{ gridTemplateColumns: '60px 1fr auto' }}>
              <div aria-hidden="true" style={{ fontSize: 36, textAlign: 'center' }}>{i.emoji}</div>
              <div><strong style={{ fontSize: 13 }}>{i.title}</strong><div className="muted" style={{ fontSize: 12 }}>Qty {i.quantity} · {formatPrice(i.unitPrice)} each</div></div>
              <div className="price" style={{ fontSize: 14 }}>{formatPrice(i.lineTotal)}</div>
            </div>
          ))}
          <h3 style={{ fontSize: 13, marginBottom: 4 }}>Delivery address</h3>
          <p style={{ fontSize: 13, margin: 0 }}>{order.address?.name} · {order.address?.phone}<br />{order.address?.line1}{order.address?.line2 ? ', ' + order.address.line2 : ''}<br />{order.address?.city}, {order.address?.state} — {order.address?.pincode}</p>
          {tracking && (
            <>
              <h3 style={{ fontSize: 13, marginBottom: 4 }}>Shipment milestones</h3>
              <ul className="history-list">
                {tracking.events.map((e) => <li key={e.eventId}><span>{new Date(e.at).toLocaleString('en-IN')}</span><strong>{e.status.replace(/_/g, ' ')}</strong><span>{e.note}</span></li>)}
              </ul>
            </>
          )}
          <h3 style={{ fontSize: 13, marginBottom: 4 }}>State history (audit trail)</h3>
          <ul className="history-list">
            {(order.history || []).map((h, i) => <li key={i}><span>{new Date(h.at).toLocaleString('en-IN')}</span><span>{h.from ? `${h.from} → ` : ''}{h.to}</span><span>{h.note || ''}</span></li>)}
          </ul>
        </section>
        <aside className="card price-summary" aria-label="Price details">
          <h2 style={{ fontSize: 16, marginTop: 0 }}>Price details</h2>
          <div className="row"><span>Items</span><span>{formatPrice(order.pricing.subtotal)}</span></div>
          <div className="row"><span>Shipping</span><span>{order.pricing.shipping === 0 ? 'FREE' : formatPrice(order.pricing.shipping)}</span></div>
          <div className="row"><span>Tax (GST 18%, incl.)</span><span>{formatPrice(order.pricing.tax)}</span></div>
          <div className="row grand"><span>Total</span><span>{formatPrice(order.pricing.total)}</span></div>
        </aside>
      </div>
      <p><Link to="/orders">← Back to your orders</Link></p>
    </>
  );
}
