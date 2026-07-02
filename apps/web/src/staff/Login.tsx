import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState('');
  const [resetSent, setResetSent] = useState(false);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api.post('/api/auth/login', { email, password, ...(totp ? { totp } : {}) });
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError) {
        const details = err.details as { totpRequired?: boolean } | undefined;
        if (details?.totpRequired) setNeedTotp(true);
        setError(err.message);
      } else setError('Login failed');
    }
  };

  const requestReset = async () => {
    if (!email) return setError('Enter your email first');
    await api.post('/api/auth/password-reset/request', { email });
    setResetSent(true);
  };

  return (
    <div className="login-shell">
      <div className="portal-card">
        <div className="portal-brand">Vibe 1099 — Staff Sign In</div>
        {error && <div className="error-box">{error}</div>}
        {resetSent && <div className="ok-box">If that account exists, a reset link was emailed.</div>}
        <form onSubmit={submit}>
          <div className="field">
            <label>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <label>Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {needTotp && (
            <div className="field">
              <label>Authenticator code</label>
              <input value={totp} onChange={(e) => setTotp(e.target.value)} maxLength={6} inputMode="numeric" />
            </div>
          )}
          <button type="submit" style={{ width: '100%' }}>Sign in</button>
        </form>
        <p className="muted" style={{ marginTop: 12 }}>
          <a onClick={requestReset} style={{ cursor: 'pointer' }}>Forgot password?</a>
        </p>
      </div>
    </div>
  );
}
