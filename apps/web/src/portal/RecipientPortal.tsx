/**
 * Recipient portal (Phase 8): token link → last-4 TIN challenge → view/download
 * Copy B PDF. Single form per token; courtesy-copy framing.
 */
import { FormEvent, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError, downloadBlob } from '../api';

interface Landing { firmName: string; taxYear: number; formType: string; challengePassed: boolean; otpRequired: boolean; otpContact: string | null }
interface FormInfo { taxYear: number; formType: string; payerName: string; corrected: boolean; note: string }

export function RecipientPortal() {
  const { token = '' } = useParams();
  const [landing, setLanding] = useState<Landing | null>(null);
  const [form, setForm] = useState<FormInfo | null>(null);
  const [last4, setLast4] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [error, setError] = useState('');
  const [attemptsRemaining, setAttemptsRemaining] = useState<number | null>(null);
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    api.get<Landing>(`/api/portal/${encodeURIComponent(token)}`)
      .then((l) => {
        setLanding(l);
        if (l.challengePassed) void loadForm();
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'This link is not valid'));
  }, [token]);

  const loadForm = () =>
    api.get<FormInfo>(`/api/portal/${encodeURIComponent(token)}/form`).then(setForm).catch(() => {});

  const sendCode = async () => {
    setError('');
    try {
      const r = await api.post<{ sent: boolean; throttled: boolean; sentTo: string }>(`/api/portal/${encodeURIComponent(token)}/request-otp`, {});
      setCodeSent(true);
      if (r.throttled) setError('A code was just sent — check your messages (you can resend in a moment).');
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not send a code'); }
  };

  const challenge = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api.post(`/api/portal/${encodeURIComponent(token)}/challenge`, { last4, ...(landing?.otpRequired ? { code } : {}) });
      setLanding((l) => (l ? { ...l, challengePassed: true } : l));
      await loadForm();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'E_LOCKED_OUT') setLocked(true);
        const d = err.details as { attemptsRemaining?: number } | undefined;
        if (d?.attemptsRemaining !== undefined) setAttemptsRemaining(d.attemptsRemaining);
        setError(err.message);
      }
    }
  };

  const download = async () => {
    const blob = await api.get<Blob>(`/api/portal/${encodeURIComponent(token)}/pdf`);
    downloadBlob(blob, `${form?.taxYear ?? ''}-1099-${form?.formType ?? ''}.pdf`);
  };

  if (!landing) {
    return (
      <div className="portal-shell">
        <div className="portal-card">{error ? <div className="error-box">{error}</div> : 'Loading…'}</div>
      </div>
    );
  }

  return (
    <div className="portal-shell">
      <div className="portal-card">
        <div className="portal-brand">{landing.firmName} — Secure Tax Document</div>

        {!landing.challengePassed ? (
          <>
            <p>Your {landing.taxYear} Form 1099-{landing.formType} is ready.</p>
            <p className="muted">To protect your information, verify the <strong>last 4 digits of your Taxpayer ID</strong> (SSN or EIN).</p>
            {error && <div className="error-box">{error}{attemptsRemaining !== null && attemptsRemaining > 0 && ` (${attemptsRemaining} attempts left)`}</div>}
            {!locked ? (
              <form onSubmit={challenge}>
                <div className="field">
                  <label>Last 4 digits</label>
                  <input value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" maxLength={4} autoFocus />
                </div>
                {landing.otpRequired && (
                  <>
                    <p className="muted" style={{ marginBottom: 6 }}>We'll also send a one-time code to {landing.otpContact ?? 'your contact on file'}.</p>
                    <button type="button" className="secondary" style={{ width: '100%', marginBottom: 8 }} onClick={sendCode}>{codeSent ? 'Resend code' : 'Send code'}</button>
                    {codeSent && (
                      <div className="field">
                        <label>6-digit code</label>
                        <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" maxLength={6} />
                      </div>
                    )}
                  </>
                )}
                <button type="submit" style={{ width: '100%' }} disabled={last4.length !== 4 || (landing.otpRequired && code.length !== 6)}>Verify</button>
              </form>
            ) : (
              <div className="warn-box">This link is temporarily locked. The issuing firm has been notified — contact them for assistance.</div>
            )}
          </>
        ) : (
          <>
            {form?.corrected && <div className="warn-box"><strong>CORRECTED</strong> — this form replaces a previously issued version.</div>}
            <p>
              <strong>{form?.taxYear} Form 1099-{form?.formType}</strong>
              {form?.payerName && <> from <strong>{form.payerName}</strong></>}
            </p>
            <p className="muted">{form?.note}</p>
            <button style={{ width: '100%' }} onClick={download}>Download PDF (Copy B + instructions)</button>
          </>
        )}
      </div>
    </div>
  );
}
