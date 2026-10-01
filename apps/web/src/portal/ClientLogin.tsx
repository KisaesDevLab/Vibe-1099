/**
 * Client sign-in without the invite link: enter the email or mobile the
 * accountant has on file → one-time code → the engagements that contact can open.
 */
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';

export interface Engagement { inviteId: string; firmName: string; payerName: string; taxYear: number; submitted: boolean }

export function ClientLogin({ onSignedIn }: { onSignedIn: (engagements: Engagement[]) => void }) {
  const [checking, setChecking] = useState(true);
  const [contact, setContact] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Already signed in on this browser (e.g. page reload)? Skip straight in.
  useEffect(() => {
    api.get<{ engagements: Engagement[] }>('/api/client-portal/login/engagements')
      .then((r) => onSignedIn(r.engagements))
      .catch(() => setChecking(false));
  }, [onSignedIn]);

  const sendCode = async () => {
    setError('');
    setBusy(true);
    try {
      await api.post('/api/client-portal/login/request', { contact });
      setCodeSent(true);
      setCode('');
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not send a code'); } finally { setBusy(false); }
  };
  const verifyCode = async () => {
    setError('');
    setBusy(true);
    try {
      const r = await api.post<{ engagements: Engagement[] }>('/api/client-portal/login/verify', { code });
      onSignedIn(r.engagements);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Incorrect code'); } finally { setBusy(false); }
  };

  if (checking) return <div className="portal-shell"><div className="portal-card">Loading…</div></div>;

  return (
    <div className="portal-shell">
      <div className="portal-card">
        <div className="portal-brand">1099 client portal</div>
        {error && <div className="error-box">{error}</div>}
        {!codeSent ? (
          <form onSubmit={(e) => { e.preventDefault(); void sendCode(); }}>
            <p>Enter the email address or mobile number your accountant has on file and we'll send you a sign-in code.</p>
            <div className="field">
              <label>Email or mobile number</label>
              <input value={contact} onChange={(e) => setContact(e.target.value)} autoComplete="username" autoFocus />
            </div>
            <button style={{ width: '100%' }} disabled={busy || !contact.trim()}>Send code</button>
            <p className="muted" style={{ marginBottom: 0 }}>Have the link from your accountant? Opening it works too.</p>
          </form>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); void verifyCode(); }}>
            <p>If <strong>{contact.trim()}</strong> is on file with your accountant, a 6-digit code is on its way. It expires in 10 minutes.</p>
            <div className="field">
              <label>6-digit code</label>
              <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus />
            </div>
            <button style={{ width: '100%', marginBottom: 8 }} disabled={busy || code.length !== 6}>Sign in</button>
            <button type="button" className="secondary" style={{ width: '100%' }} disabled={busy} onClick={() => { setCodeSent(false); setError(''); }}>Use a different email or number</button>
            <p className="muted" style={{ marginBottom: 0 }}>No code? Check the address or number, or ask your accountant to resend your link.</p>
          </form>
        )}
      </div>
    </div>
  );
}
