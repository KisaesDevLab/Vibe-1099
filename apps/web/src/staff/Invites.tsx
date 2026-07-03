import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { Combobox } from '../components/Combobox';

interface Invite {
  id: string;
  payerId: string;
  payerName: string;
  taxYear: number;
  formTypes: string[];
  email: string | null;
  mobile: string | null;
  expiresAt: string;
  revokedAt: string | null;
  submittedAt: string | null;
  lastActivityAt: string | null;
}

interface Payer { id: string; legalName: string; contactEmail: string | null; defaultFormTypes?: string[] }

export function Invites() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [payers, setPayers] = useState<Payer[]>([]);
  const [payerId, setPayerId] = useState('');
  const [taxYear, setTaxYear] = useState(2026);
  const [formTypes, setFormTypes] = useState<string[]>(['NEC']);
  const [link, setLink] = useState('');
  const [error, setError] = useState('');

  const load = () => api.get<{ invites: Invite[] }>('/api/invites').then((r) => setInvites(r.invites));
  useEffect(() => {
    void load();
    api.get<{ payers: Payer[] }>('/api/payers?limit=1000').then((r) => {
      setPayers(r.payers);
      if (r.payers[0]) { setPayerId(r.payers[0].id); if (r.payers[0].defaultFormTypes?.length) setFormTypes(r.payers[0].defaultFormTypes); }
    });
  }, []);

  // when the selected payer changes, default the form-type picker to its preset
  const onPayerChange = (id: string) => {
    setPayerId(id);
    const p = payers.find((x) => x.id === id);
    if (p?.defaultFormTypes?.length) setFormTypes(p.defaultFormTypes);
  };

  const toggleType = (t: string) =>
    setFormTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const r = await api.post<{ id: string; link: string }>('/api/invites', { payerId, taxYear, formTypes });
      setLink(r.link);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const action = async (id: string, verb: 'revoke' | 'reissue' | 'reopen') => {
    const r = await api.post<{ link?: string }>(`/api/invites/${id}/${verb}`);
    if (r.link) setLink(r.link);
    load();
  };

  return (
    <div>
      <h1>Client invites</h1>
      {error && <div className="error-box">{error}</div>}
      {link && (
        <div className="ok-box">
          Magic link (also sent to the payer contact if on file):<br />
          <span className="mono" style={{ wordBreak: 'break-all' }}>{link}</span>
        </div>
      )}
      <form className="panel" onSubmit={create}>
        <div className="row">
          <div className="field grow"><label>Payer</label>
            <Combobox options={payers.map((p) => ({ value: p.id, label: p.legalName }))} value={payerId} onChange={onPayerChange} placeholder="Search payers…" /></div>
          <div className="field"><label>Tax year</label>
            <select value={taxYear} onChange={(e) => setTaxYear(Number(e.target.value))}>
              <option value={2026}>2026</option><option value={2025}>2025</option>
            </select></div>
          <div className="field">
            <label>Form types the client may enter</label>
            <div className="row" style={{ gap: 8 }}>
              {['NEC', 'MISC', 'INT', 'DIV'].map((t) => (
                <label key={t} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 13, color: 'var(--text)' }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={formTypes.includes(t)} onChange={() => toggleType(t)} /> {t}
                </label>
              ))}
            </div>
          </div>
          <button type="submit" disabled={!formTypes.length}>Generate magic link</button>
        </div>
      </form>

      <table className="grid">
        <thead><tr><th>Payer</th><th>Year</th><th>Types</th><th>Status</th><th>Expires</th><th>Last activity</th><th></th></tr></thead>
        <tbody>
          {invites.map((inv) => (
            <tr key={inv.id}>
              <td>{inv.payerName}</td>
              <td>{inv.taxYear}</td>
              <td>{inv.formTypes.join(', ')}</td>
              <td>
                {inv.revokedAt ? <span className="badge err">revoked</span>
                  : inv.submittedAt ? <span className="badge ok">submitted</span>
                  : new Date(inv.expiresAt) < new Date() ? <span className="badge warn">expired</span>
                  : <span className="badge ready">open</span>}
              </td>
              <td>{new Date(inv.expiresAt).toLocaleDateString()}</td>
              <td>{inv.lastActivityAt ? new Date(inv.lastActivityAt).toLocaleString() : '—'}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {!inv.revokedAt && !inv.submittedAt && <button className="small danger" onClick={() => action(inv.id, 'revoke')}>Revoke</button>}
                <button className="small secondary" onClick={() => action(inv.id, 'reissue')}>Reissue</button>
                {inv.submittedAt && <button className="small secondary" onClick={() => action(inv.id, 'reopen')}>Re-open</button>}
              </td>
            </tr>
          ))}
          {!invites.length && <tr><td colSpan={7} className="muted">No invites yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
