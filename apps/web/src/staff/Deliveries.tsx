import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError } from '../api';

interface Delivery {
  id: string;
  formRecordId: string;
  channel: 'paper' | 'email' | 'sms';
  isCorrected: boolean;
  sentAt: string | null;
  bouncedAt: string | null;
  viewedAt: string | null;
  downloadedAt: string | null;
  failReason: string | null;
  tokenExpiresAt: string | null;
  tokenRevokedAt: string | null;
  createdAt: string;
}

interface Payer { id: string; legalName: string }

export function Deliveries() {
  const [rows, setRows] = useState<Delivery[]>([]);
  const [payers, setPayers] = useState<Payer[]>([]);
  const [payerIds, setPayerIds] = useState<string[]>([]);
  const [taxYear, setTaxYear] = useState(2026);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const load = () => api.get<{ deliveries: Delivery[] }>('/api/deliveries').then((r) => setRows(r.deliveries));
  useEffect(() => {
    void load();
    api.get<{ payers: Payer[] }>('/api/payers').then((r) => { setPayers(r.payers); setPayerIds(r.payers.map((p) => p.id)); });
  }, []);

  const compose = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const r = await api.post<{ queued: number; paperOnly: number }>('/api/deliveries/compose', { taxYear, payerIds });
      setNotice(`${r.queued} portal link(s) queued (email preferred, SMS fallback). ${r.paperOnly} recipient(s) are paper-only.`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const resend = async (id: string) => {
    await api.post(`/api/deliveries/${id}/resend`).catch((err: ApiError) => setError(err.message));
    setNotice('Re-sent with a fresh token (old link revoked).');
    load();
  };

  const revoke = async (id: string) => {
    await api.post(`/api/deliveries/${id}/revoke`);
    load();
  };

  const status = (d: Delivery) => {
    if (d.tokenRevokedAt) return <span className="badge err">revoked</span>;
    if (d.bouncedAt) return <span className="badge err" title={d.failReason ?? ''}>bounced</span>;
    if (d.downloadedAt) return <span className="badge ok">downloaded</span>;
    if (d.viewedAt) return <span className="badge ok">viewed</span>;
    if (d.sentAt) return <span className="badge ready">sent</span>;
    return <span className="badge draft">pending</span>;
  };

  return (
    <div>
      <h1>Deliveries</h1>
      {error && <div className="error-box">{error}</div>}
      {notice && <div className="ok-box">{notice}</div>}

      <form className="panel" onSubmit={compose}>
        <div className="row">
          <div className="field"><label>Tax year</label>
            <select value={taxYear} onChange={(e) => setTaxYear(Number(e.target.value))}>
              <option value={2026}>2026</option><option value={2025}>2025</option>
            </select></div>
          <div className="field grow">
            <label>Payers</label>
            <div className="row" style={{ gap: 8 }}>
              {payers.map((p) => (
                <label key={p.id} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 13, color: 'var(--text)' }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={payerIds.includes(p.id)}
                    onChange={() => setPayerIds((cur) => (cur.includes(p.id) ? cur.filter((x) => x !== p.id) : [...cur, p.id]))} /> {p.legalName}
                </label>
              ))}
            </div>
          </div>
          <button type="submit">Send portal links (accepted forms)</button>
        </div>
        <p className="muted">Courtesy copies — the paper Copy B is always mailed (delivery policy b). Links carry opaque tokens only.</p>
      </form>

      <table className="grid">
        <thead><tr><th>Channel</th><th>Status</th><th>Corrected</th><th>Expires</th><th>Created</th><th></th></tr></thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              <td>{d.channel}</td>
              <td>{status(d)}</td>
              <td>{d.isCorrected ? <span className="badge corrected">CORRECTED</span> : ''}</td>
              <td>{d.tokenExpiresAt ? new Date(d.tokenExpiresAt).toLocaleDateString() : '—'}</td>
              <td>{new Date(d.createdAt).toLocaleString()}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {d.channel !== 'paper' && !d.tokenRevokedAt && (
                  <>
                    <button className="small secondary" onClick={() => resend(d.id)}>Resend</button>
                    <button className="small danger" onClick={() => revoke(d.id)}>Revoke</button>
                  </>
                )}
              </td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={6} className="muted">No deliveries yet — build a paper batch or compose portal links.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
