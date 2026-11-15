import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Notification } from '../api';
import { useSession } from '../session';

export default function NotificationsPage() {
  const { session, loading } = useSession();
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ notifications: Notification[]; unreadCount: number }>('/v1/notifications');
      setItems(res.notifications);
      setUnread(res.unreadCount);
    } catch (e: any) { setError(e.message); }
  }, []);

  useEffect(() => { if (session?.authenticated) load(); }, [session, load]);

  async function markRead(id: string) { await api.post(`/v1/notifications/${id}/read`).catch(() => {}); load(); }
  async function markAllRead() { await api.post('/v1/notifications/read-all').catch(() => {}); load(); }

  if (loading) return <div className="skeleton" style={{ height: 200 }} />;
  if (!session?.authenticated) return <div className="card form-narrow"><h1>Notifications</h1><p>Please <Link to="/login?next=/notifications">sign in</Link>.</p></div>;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 className="section-title">Notifications {unread > 0 && <span className="cart-count" style={{ background: 'var(--accent)', padding: '2px 10px', fontSize: 13 }}>{unread} new</span>}</h1>
        {items.length > 0 && <button className="btn btn-secondary" onClick={markAllRead}>Mark all as read</button>}
      </div>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <div className="notifications-list" aria-live="polite">
        {items.map((n) => (
          <div key={n._id} className={`notification-item ${n.readAt ? '' : 'unread'}`}>
            <div>
              <strong>{n.subject}</strong>
              <p style={{ margin: '4px 0' }}>{n.body}</p>
              <span className="muted" style={{ fontSize: 11 }}>{new Date(n.createdAt).toLocaleString('en-IN')}{n.orderId ? <> · <Link to={`/orders/${n.orderId}`}>Order #{n.orderId}</Link></> : null}</span>
            </div>
            {!n.readAt && <button className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => markRead(n._id)} aria-label="Mark as read">✓ Read</button>}
          </div>
        ))}
        {items.length === 0 && <p className="muted">No notifications yet. Order updates will appear here.</p>}
      </div>
    </>
  );
}
