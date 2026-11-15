import { FormEvent, useState } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { api, setCsrfToken } from '../api';
import { useSession } from '../session';

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { reload, refreshCartCount } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const next = new URLSearchParams(location.search).get('next') || '/';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await api.post<{ csrfToken: string }>('/v1/auth/login', { email, password, ...(otp ? { otp } : {}) });
      setCsrfToken(res.csrfToken);
      await reload();
      await refreshCartCount();
      navigate(next);
    } catch (e: any) {
      setError(e.message || 'Login failed');
    } finally { setBusy(false); }
  }

  return (
    <div className="card form-narrow">
      <h1>Sign in</h1>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <form onSubmit={submit}>
        <div className="form-group"><label htmlFor="email">Email</label><input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="demo@bazaarly.test" /></div>
        <div className="form-group"><label htmlFor="password">Password</label><input id="password" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        <div className="form-group"><label htmlFor="otp">Admin OTP (only if MFA is enabled)</label><input id="otp" inputMode="numeric" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="123456" /></div>
        <button type="submit" className="btn btn-yellow btn-block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p style={{ marginTop: 14 }}>New to Bazaarly? <Link to="/register">Create your account</Link></p>
      <div className="alert alert-info" style={{ fontSize: 12 }}>
        Demo: <code>demo@bazaarly.test</code> / <code>Demo@12345</code><br />Admin: <code>admin@bazaarly.test</code> / <code>Admin@12345</code>
      </div>
    </div>
  );
}
