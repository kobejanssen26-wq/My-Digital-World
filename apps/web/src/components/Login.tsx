import { useState, type FormEvent } from 'react';
import { ApiError } from '../api.js';
import { useStore } from '../store.js';
import { ErrorBanner } from './ui.js';

export function Login({ unconfigured }: { unconfigured: boolean }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await useStore.getState().login(password);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'network';
      setError(code === 'invalid_credentials' ? 'Wrong password.' : code === 'rate_limited' ? 'Too many attempts. Wait a few minutes and try again.' : code === 'not_configured' ? 'This deployment has no password yet.' : 'Could not sign in. Check your connection.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="card" onSubmit={submit} aria-labelledby="login-title">
        <div className="brand" style={{ padding: 0 }}>
          <i><svg viewBox="0 0 32 32"><path d="M7 22V12l9-5 9 5v10l-9 4z" /></svg></i>
          <span id="login-title">My Digital World</span>
        </div>
        {unconfigured && (
          <ErrorBanner>
            No admin password is configured for this deployment. Run <code>npm run setup:secrets</code> and redeploy.
          </ErrorBanner>
        )}
        <label className="grow">
          <span className="sr-only">Password</span>
          <input type="password" autoFocus autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: '100%' }} aria-invalid={!!error} />
        </label>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <button className="btn primary" disabled={busy || !password} type="submit">{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </main>
  );
}
