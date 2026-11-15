import { FormEvent, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api, setCsrfToken } from '../api';
import { useSession } from '../session';

export default function RegisterPage() {
  const navigate = useNavigate();
  const { reload } = useSession();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await api.post<{ csrfToken: string }>('/v1/auth/register', { name, email, password });
      setCsrfToken(res.csrfToken);
      await reload();
      navigate('/');
    } catch (e: any) {
      setError(e.details ? `Please check: ${JSON.stringify(e.details)}` : (e.message || 'Registration failed'));
    } finally { setBusy(false); }
  }

  return (
    <div className="card form-narrow">
      <h1>Create account</h1>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <form onSubmit={submit}>
        <div className="form-group"><label htmlFor="name">Your name</label><input id="name" required minLength={2} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="form-group"><label htmlFor="email">Email</label><input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="form-group"><label htmlFor="password">Password (min 8 characters)</label><input id="password" type="password" required minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        <button type="submit" className="btn btn-yellow btn-block" disabled={busy}>{busy ? 'Creating account…' : 'Create your Bazaarly account'}</button>
      </form>
      <p style={{ marginTop: 14 }}>Already have an account? <Link to="/login">Sign in</Link></p>
    </div>
  );
}
