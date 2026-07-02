import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError, downloadBlob } from '../api';

interface W9Row {
  id: string;
  recipientId: string | null;
  recipientName: string;
  email: string | null;
  mobile: string | null;
  status: string;
  ageDays: number;
  remindersSent: number;
  tinMismatch: boolean;
  expiresAt: string;
  completedAt: string | null;
}

export function W9Dashboard() {
  const [rows, setRows] = useState<W9Row[]>([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = () => api.get<{ requests: W9Row[] }>('/api/w9/requests').then((r) => setRows(r.requests));
  useEffect(() => { void load(); }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const r = await api.post<{ id: string; link: string }>('/api/w9/requests', {
        name: name || undefined,
        email: email || null,
        mobile: mobile || null,
      });
      setNotice(`W-9 request sent. Link: ${r.link}`);
      setName(''); setEmail(''); setMobile('');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const resend = async (id: string) => {
    await api.post(`/api/w9/requests/${id}/resend`);
    setNotice('Reminder sent with a fresh link.');
    load();
  };

  const pdf = async (id: string) => {
    const blob = await api.get<Blob>(`/api/w9/requests/${id}/pdf`);
    downloadBlob(blob, 'w9.pdf');
  };

  const resolveMismatch = async (id: string, applyTin: boolean) => {
    await api.post(`/api/w9/requests/${id}/resolve-mismatch`, { applyTin });
    setNotice(applyTin ? 'W-9 TIN applied to the vault.' : 'Mismatch dismissed — vault TIN kept.');
    load();
  };

  const staleSweep = async () => {
    const r = await api.post<{ marked: number }>('/api/w9/stale-sweep');
    setNotice(`${r.marked} recipient(s) marked stale (W-9 older than the configured threshold).`);
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>W-9 requests</h1>
        <button className="secondary" onClick={staleSweep}>Run stale-W-9 sweep</button>
      </div>
      {error && <div className="error-box">{error}</div>}
      {notice && <div className="ok-box" style={{ wordBreak: 'break-all' }}>{notice}</div>}

      <form className="panel" onSubmit={create}>
        <div className="row">
          <div className="field grow"><label>Name (optional — new contractor)</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field grow"><label>Email</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="field grow"><label>Mobile</label><input value={mobile} onChange={(e) => setMobile(e.target.value)} /></div>
          <button type="submit">Send W-9 request</button>
        </div>
        <p className="muted">Tip: request a W-9 for an existing vault recipient from the Recipients page — it links automatically.</p>
      </form>

      <table className="grid">
        <thead><tr><th>Who</th><th>Sent to</th><th>Status</th><th>Age</th><th>Reminders</th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.recipientName || <span className="muted">unnamed</span>}
                {r.tinMismatch && <span className="badge err" style={{ marginLeft: 6 }}>TIN MISMATCH</span>}</td>
              <td>{r.email ?? r.mobile}</td>
              <td><span className={`badge ${r.status === 'completed' ? 'ok' : r.status === 'expired' ? 'err' : 'warn'}`}>{r.status}</span></td>
              <td>{r.ageDays}d</td>
              <td>{r.remindersSent}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {['sent', 'opened', 'expired'].includes(r.status) && <button className="small secondary" onClick={() => resend(r.id)}>Resend</button>}
                {r.status === 'completed' && <button className="small secondary" onClick={() => pdf(r.id)}>PDF</button>}
                {r.tinMismatch && (
                  <>
                    <button className="small" onClick={() => resolveMismatch(r.id, true)}>Use W-9 TIN</button>
                    <button className="small secondary" onClick={() => resolveMismatch(r.id, false)}>Keep vault TIN</button>
                  </>
                )}
              </td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={6} className="muted">No W-9 requests yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
