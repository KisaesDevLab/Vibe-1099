import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { Combobox } from '../components/Combobox';
import { useDialogs } from '../components/Dialogs';
import { useTaxYears } from '../components/useTaxYears';

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

interface Payer { id: string; legalName: string; contactEmail: string | null; contactMobile?: string | null; defaultFormTypes?: string[] }

export function Invites() {
  const dialogs = useDialogs();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [payers, setPayers] = useState<Payer[]>([]);
  const [payerId, setPayerId] = useState('');
  const [taxYear, setTaxYear] = useState(2026);
  const { years: taxYears, current: currentYear } = useTaxYears();
  useEffect(() => { setTaxYear(currentYear); }, [currentYear]);
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

  // Where the link goes. Prefilled from the payer's contacts so staff can see
  // (and override) the destination instead of it being sent invisibly.
  const [sendEmail, setSendEmail] = useState(true);
  const [sendSms, setSendSms] = useState(true);
  const [toEmail, setToEmail] = useState('');
  const [toMobile, setToMobile] = useState('');

  const fillContacts = (id: string) => {
    const p = payers.find((x) => x.id === id);
    setToEmail(p?.contactEmail ?? '');
    setToMobile(p?.contactMobile ?? '');
  };
  useEffect(() => { if (payerId) fillContacts(payerId); }, [payerId, payers]);

  // when the selected payer changes, default the form-type picker to its preset
  const onPayerChange = (id: string) => {
    setPayerId(id);
    const p = payers.find((x) => x.id === id);
    if (p?.defaultFormTypes?.length) setFormTypes(p.defaultFormTypes);
    fillContacts(id);
  };

  const toggleType = (t: string) =>
    setFormTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const r = await api.post<{ id: string; link: string; sentEmail: boolean; sentSms: boolean }>('/api/invites', {
        payerId,
        taxYear,
        formTypes,
        email: toEmail.trim() || null,
        mobile: toMobile.trim() || null,
        sendEmail,
        sendSms,
      });
      setLink(r.link);
      const channels = [r.sentEmail && `email (${toEmail.trim()})`, r.sentSms && `text (${toMobile.trim()})`].filter(Boolean);
      dialogs.toast(
        channels.length ? `Invite sent by ${channels.join(' and ')}.` : 'Link generated — nothing sent. Copy it below and send it yourself.',
        channels.length ? 'success' : 'info',
      );
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

  // Fresh link straight to the clipboard (reissues under the hood — the old
  // link is superseded, expiry restarts).
  const copyLink = async (id: string) => {
    try {
      const r = await api.post<{ link: string }>(`/api/invites/${id}/reissue`);
      await navigator.clipboard?.writeText(r.link);
      setLink(r.link);
      dialogs.toast('Fresh link copied to clipboard.', 'success');
      load();
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
  };

  const resend = async (id: string, payerName: string) => {
    try {
      const r = await api.post<{ link: string; sentEmail: boolean; sentSms: boolean }>(`/api/invites/${id}/resend`);
      setLink(r.link);
      dialogs.toast(
        r.sentEmail || r.sentSms
          ? `Invite re-sent to ${payerName}${r.sentEmail && r.sentSms ? ' (email + SMS)' : r.sentEmail ? ' (email)' : ' (SMS)'}.`
          : `No contact on file for ${payerName} — fresh link generated above; copy it to them directly.`,
        r.sentEmail || r.sentSms ? 'success' : 'warning',
      );
      load();
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
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
              {taxYears.map((y) => <option key={y} value={y}>{y}</option>)}
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
        </div>
        {/* delivery: visible destinations + explicit send toggles */}
        <div className="row">
          <div className="field grow">
            <label>
              <input type="checkbox" style={{ width: 'auto' }} checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} /> Email the link to
            </label>
            <input value={toEmail} disabled={!sendEmail} placeholder="client@example.com" onChange={(e) => setToEmail(e.target.value)} />
          </div>
          <div className="field grow">
            <label>
              <input type="checkbox" style={{ width: 'auto' }} checked={sendSms} onChange={(e) => setSendSms(e.target.checked)} /> Text the link to
            </label>
            <input value={toMobile} disabled={!sendSms} placeholder="(816) 555-0123" onChange={(e) => setToMobile(e.target.value)} />
          </div>
          <button type="submit" disabled={!formTypes.length} style={{ alignSelf: 'flex-end' }}>
            {(sendEmail && toEmail.trim()) || (sendSms && toMobile.trim()) ? 'Generate & send link' : 'Generate link'}
          </button>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Prefilled from the payer’s contact details. Clear a box or untick it to skip that channel — the link is always shown here so you can
          send it yourself.
        </p>
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
                {!inv.submittedAt && (<>
                  <button className="small secondary" onClick={() => void copyLink(inv.id)} title="Mint a fresh link and copy it to the clipboard (the old link stops working; expiry restarts)">Copy link</button>
                  <button className="small secondary" onClick={() => void resend(inv.id, inv.payerName)} title="Mint a fresh link and email/text it to the contact on file">Resend</button>
                </>)}
                {!inv.revokedAt && !inv.submittedAt && <button className="small danger" onClick={() => action(inv.id, 'revoke')}>Revoke</button>}
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
