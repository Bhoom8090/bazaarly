import { Routes, Route, Link } from 'react-router-dom';
import { SessionProvider } from './session';
import Header from './components/Header';
import Home from './pages/Home';
import CategoryPage from './pages/CategoryPage';
import SearchPage from './pages/SearchPage';
import ProductPage from './pages/ProductPage';
import CartPage from './pages/CartPage';
import CheckoutPage from './pages/CheckoutPage';
import OrdersPage from './pages/OrdersPage';
import OrderDetailPage from './pages/OrderDetailPage';
import NotificationsPage from './pages/NotificationsPage';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import AdminPage from './pages/AdminPage';

export default function App() {
  return (
    <SessionProvider>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <Header />
      <div aria-live="polite" className="sr-only" id="status-region" />
      <main id="main-content" className="container">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/c/:category" element={<CategoryPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/p/:id" element={<ProductPage />} />
          <Route path="/cart" element={<CartPage />} />
          <Route path="/checkout" element={<CheckoutPage />} />
          <Route path="/orders" element={<OrdersPage />} />
          <Route path="/orders/:id" element={<OrderDetailPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={<div className="card"><h1>Page not found</h1><p><Link to="/">Back to Bazaarly home</Link></p></div>} />
        </Routes>
      </main>
      <a className="back-top" href="#main-content">Back to top</a>
      <footer className="footer" role="contentinfo">
        <p><strong>Bazaarly</strong> — a demo marketplace. Single merchant, INR pricing, sandbox payments only. No real orders are placed.</p>
        <p>Need help? Visit <Link to="/notifications">your notifications</Link> · <Link to="/orders">track orders</Link> · <Link to="/login">account</Link></p>
        <p>© {new Date().getFullYear()} Bazaarly Pvt. Ltd. (educational project). Not affiliated with Amazon.</p>
      </footer>
    </SessionProvider>
  );
}
