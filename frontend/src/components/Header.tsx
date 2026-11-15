import { FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useSession } from '../session';
import { api, setCsrfToken, Session } from '../api';

const CATEGORIES = ['Electronics', 'Books', 'Home & Kitchen', 'Fashion', 'Toys & Games', 'Sports & Fitness'];

export default function Header() {
  const { session, reload, cartCount } = useSession();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get('q') || '');
  const [category, setCategory] = useState('');
  const navigate = useNavigate();
  const user = session?.user;

  function onSearch(e: FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams();
    if (query.trim()) params.set('q', query.trim());
    if (category) params.set('category', category);
    navigate(`/search?${params.toString()}`);
  }

  async function logout() {
    try { await api.post('/v1/auth/logout'); } catch { /* ignore */ }
    setCsrfToken(undefined);
    await reload();
    navigate('/');
  }

  return (
    <header className="header" role="banner">
      <div className="header-inner">
        <Link to="/" className="logo" aria-label="Bazaarly home">Bazaar<span>ly</span><small>IN · DELIVER TO YOU</small></Link>
        <div className="deliver-to" aria-hidden="true">📍 Deliver to<br /><strong>India</strong></div>
        <form className="searchbar" role="search" onSubmit={onSearch}>
          <label htmlFor="category-select" className="sr-only">Select category</label>
          <select id="category-select" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Search in category">
            <option value="">All</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <label htmlFor="search-input" className="sr-only">Search products</label>
          <input id="search-input" type="search" placeholder="Search Bazaarly" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={100} autoComplete="off" />
          <button type="submit" aria-label="Search">🔍</button>
        </form>
        <nav className="header-nav" aria-label="Account and cart">
          {user ? (
            <>
              <span><span className="sub">Hello, {user.name.split(' ')[0]}</span><br />
                {user.role === 'admin' ? <Link to="/admin">Admin Dashboard</Link> : <Link to="/orders">Returns &amp; Orders</Link>}
              </span>
              <button className="linkish" onClick={logout}>Sign out</button>
            </>
          ) : (
            <Link to="/login"><span className="sub">Hello, sign in</span><br /><strong>Account &amp; Lists</strong></Link>
          )}
          <Link to="/notifications" aria-label="Notifications">🔔<span className="sub"> Alerts</span></Link>
          <Link to="/cart" className="cart-link" aria-label={`Cart, ${cartCount} items`}><span className="cart-count">{cartCount}</span>Cart</Link>
        </nav>
      </div>
      <nav className="subnav" aria-label="Shop by category">
        <div className="subnav-inner">
          <Link to="/">☰ All</Link>
          {CATEGORIES.map((c) => <Link key={c} to={`/c/${encodeURIComponent(c)}`}>{c}</Link>)}
          <Link to="/orders">My Orders</Link>
        </div>
      </nav>
    </header>
  );
}
