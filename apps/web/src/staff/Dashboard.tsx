import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

const CURRENT_TY = 2026;

interface Progress {
  payerId: string;
  payerName: string;
  total: number;
  entered: number;
  ready: number;
  transmitted: number;
  accepted: number;
  rejected: number;
  delivered: number;
}

interface Exception {
  kind: string;
  formRecordId?: string;
  recipientId?: string;
  recipientName: string;
  formType?: string;
  detail: string;
}

export function Dashboard() {
  const [taxYear, setTaxYear] = useState(CURRENT_TY);
  const [season, setSeason] = useState<{ progress: Progress[]; deadlines: Record<string, string>; yearLocked: boolean } | null>(null);
  const [deadlines, setDeadlines] = useState<{ deadlines: Record<string, { date: string; note: string }>; counts: Record<string, number> } | null>(null);
  const [exceptions, setExceptions] = useState<Exception[]>([]);
  const [vault, setVault] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    api.get<{ progress: Progress[]; deadlines: Record<string, string>; yearLocked: boolean }>(`/api/dashboard/season/${taxYear}`).then(setSeason).catch(() => {});
    api.get<{ deadlines: Record<string, { date: string; note: string }>; counts: Record<string, number> }>(`/api/iris/deadlines/${taxYear}`).then(setDeadlines).catch(() => {});
    api.get<{ exceptions: Exception[] }>(`/api/dashboard/exceptions/${taxYear}`).then((r) => setExceptions(r.exceptions)).catch(() => {});
    api.get<{ stats: Record<string, number> }>('/api/recipients/stats').then((r) => setVault(r.stats)).catch(() => {});
  }, [taxYear]);

  const daysUntil = (date: string) => Math.ceil((new Date(date + 'T23:59:59').getTime() - Date.now()) / 86_400_000);

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Season dashboard — TY{taxYear}</h1>
        <div className="field" style={{ minWidth: 100 }}>
          <label>Tax year</label>
          <select value={taxYear} onChange={(e) => setTaxYear(Number(e.target.value))}>
            <option value={2026}>2026</option>
            <option value={2025}>2025</option>
          </select>
        </div>
      </div>

      {season?.yearLocked && <div className="warn-box">Tax year {taxYear} is locked (read-only except corrections).</div>}

      {deadlines && (
        <div className="stat-row">
          {Object.entries(deadlines.deadlines).map(([key, d]) => (
            <div className="stat" key={key} title={d.note}>
              <div className="n" style={{ color: daysUntil(d.date) < 14 ? 'var(--danger)' : undefined }}>
                {daysUntil(d.date) >= 0 ? `${daysUntil(d.date)}d` : 'past'}
              </div>
              <div className="l">
                {key === 'recipientFurnish' ? 'Recipient copies (Jan 31)' : key === 'irsEfile' ? 'IRS e-file (Mar 31)' : 'Missouri (end of Feb)'}
              </div>
              <div className="muted">{d.date}</div>
            </div>
          ))}
          {deadlines.counts && (
            <div className="stat">
              <div className="n">{deadlines.counts['unfiled'] ?? 0}</div>
              <div className="l">Unfiled forms</div>
            </div>
          )}
          {vault && (
            <div className="stat">
              <div className="n">{vault['total'] ?? 0}</div>
              <div className="l">Vault recipients ({vault['w9Missing'] ?? 0} missing W-9)</div>
            </div>
          )}
        </div>
      )}

      <h2>Progress by payer</h2>
      <table className="grid">
        <thead>
          <tr>
            <th>Payer</th><th className="num">Total</th><th className="num">Draft</th><th className="num">Ready/Queued</th>
            <th className="num">Transmitted</th><th className="num">Accepted</th><th className="num">Rejected</th><th className="num">Delivered</th>
          </tr>
        </thead>
        <tbody>
          {season?.progress.map((p) => (
            <tr key={p.payerId}>
              <td><Link to={`/forms?payerId=${p.payerId}&taxYear=${taxYear}`}>{p.payerName}</Link></td>
              <td className="num">{p.total}</td>
              <td className="num">{p.entered}</td>
              <td className="num">{p.ready}</td>
              <td className="num">{p.transmitted}</td>
              <td className="num" style={{ color: 'var(--ok)' }}>{p.accepted}</td>
              <td className="num" style={{ color: p.rejected ? 'var(--danger)' : undefined }}>{p.rejected}</td>
              <td className="num">{p.delivered}</td>
            </tr>
          ))}
          {!season?.progress.length && <tr><td colSpan={8} className="muted">No form records yet for TY{taxYear}.</td></tr>}
        </tbody>
      </table>

      <h2>Exception queue ({exceptions.length})</h2>
      <table className="grid">
        <thead><tr><th>Type</th><th>Who</th><th>Detail</th></tr></thead>
        <tbody>
          {exceptions.slice(0, 50).map((e, i) => (
            <tr key={i}>
              <td><span className={`badge ${e.kind === 'rejected' ? 'err' : 'warn'}`}>{e.kind.replace('_', ' ')}</span></td>
              <td>{e.recipientName}{e.formType ? ` (1099-${e.formType})` : ''}</td>
              <td>{e.detail}</td>
            </tr>
          ))}
          {!exceptions.length && <tr><td colSpan={3} className="muted">No exceptions. Clean season so far.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
