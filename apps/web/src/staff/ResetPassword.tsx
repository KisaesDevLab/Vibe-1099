import { FormEvent, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError('Passwords do not match');
    if (password.length < 12) return setError('Password must be at least 12 characters');
    try {
      await api.post('/api/auth/password-reset/complete', { token, password });
      navigate('/login');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Reset failed');
    }
  };

  return (
    <div className="login-shell">
      <div className="portal-card">
        <div className="portal-brand">Reset password</div>
        {error && <div className="error-box">{error}</div>}
        <form onSubmit={submit}>
          <div className="field">
            <label>New password (12+ characters)</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="field">
            <label>Confirm</label>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
          <button type="submit" style={{ width: '100%' }}>Set password</button>
        </form>
      </div>
    </div>
  );
}
