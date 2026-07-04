/**
 * Consolidated per-payer filing status — one row per payer with the filing
 * date/receipt/status and any rejected 1099s (with reasons), for a tax year.
 */
import { Fragment, useEffect, useState } from 'react';
import { api } from '../api';
import { useTaxYears } from '../components/useTaxYears';

interface Reject { recipientName: string; formType: string; reasons: string[] }
interface PayerFiling {
  payerId: string;
  payerName: string;
  clientId: string | null;
  total: number;
  status: string;
  counts: Record<string, number>;
  filedAt: string | null;
  receiptId: string | null;
  environment: string | null;
  rejectCount: number;
  rejects: Reject[];
}

const statusBadge = (s: string) =>
  s === 'accepted' ? 'accepted'
    : s.includes('rejected') ? 'rejected'
      : s.startsWith('transmitted') ? 'queued'
        : s === 'not filed' ? 'draft'
          : s.includes('accepted') ? 'accepted_with_errors'
            : 'ready';

export function FilingStatus() {
  const { years, current } = useTaxYears();
  const [taxYear, setTaxYear] = useState(current);
  const [rows, setRows] = useState<PayerFiling[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => setTaxYear(current), [current]);
  useEffect(() => {
    setLoading(true);
    api.get<{ payers: PayerFiling[] }>(`/api/dashboard/filing-status/${taxYear}`)
      .then((r) => setRows(r.payers))
      .finally(() => setLoading(false));
  }, [taxYear]);

  const q = search.trim().toLowerCase();
  const filtered = q
    ? rows.filter((r) => r.payerName.toLowerCase().includes(q) || (r.clientId ?? '').toLowerCase().includes(q))
    : rows;

  const totals = rows.reduce((acc, r) => {
    if (r.status === 'accepted') acc.accepted++;
    else if (r.status.includes('rejected')) acc.rejected++;
    else if (r.status === 'not filed') acc.notFiled++;
    else acc.inProgress++;
    return acc;
  }, { accepted: 0, rejected: 0, inProgress: 0, notFiled: 0 });

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Filing status</h1>
        <div className="field" style={{ maxWidth: 120 }}>
          <label>Tax year</label>
          <select value={taxYear} onChange={(e) => setTaxYear(Number(e.target.value))}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      <div className="panel" style={{ padding: '8px 14px' }}>
        <div className="row" style={{ gap: 20, alignItems: 'center' }}>
          <span className="group-label">Payers</span>
          <span>Accepted: <strong style={{ color: 'var(--ok)' }}>{totals.accepted}</strong></span>
          <span>Rejected: <strong style={{ color: 'var(--danger)' }}>{totals.rejected}</strong></span>
          <span>In progress: <strong style={{ color: 'var(--warn)' }}>{totals.inProgress}</strong></span>
          <span>Not filed: <strong className="muted">{totals.notFiled}</strong></span>
          <div className="spacer" />
          <input placeholder="Search client ID or name…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 240 }} />
        </div>
      </div>

      <table className="grid">
        <thead>
          <tr><th>Client ID</th><th>Payer</th><th>Forms</th><th>Status</th><th>Filed</th><th>Receipt</th><th>Rejects</th></tr>
        </thead>
        <tbody>
          {filtered.map((r) => (
            <Fragment key={r.payerId}>
              <tr>
                <td className="mono">{r.clientId ?? <span className="muted">—</span>}</td>
                <td>{r.payerName}</td>
                <td>{r.total}</td>
                <td><span className={`badge ${statusBadge(r.status)}`}>{r.status}</span>{r.environment === 'ATS' && <span className="badge warn" style={{ marginLeft: 4 }}>ATS</span>}</td>
                <td>{r.filedAt ?? <span className="muted">—</span>}</td>
                <td className="mono" title={r.receiptId ?? ''}>{r.receiptId ? `${r.receiptId.slice(0, 14)}…` : <span className="muted">—</span>}</td>
                <td>
                  {r.rejectCount > 0
                    ? <button className="small danger" onClick={() => setExpanded(expanded === r.payerId ? null : r.payerId)}>{r.rejectCount} — {expanded === r.payerId ? 'hide' : 'view'}</button>
                    : <span className="muted">0</span>}
                </td>
              </tr>
              {expanded === r.payerId && r.rejects.map((rej, i) => (
                <tr key={`${r.payerId}-${i}`} style={{ background: '#fef2f2' }}>
                  <td></td>
                  <td colSpan={6} style={{ fontSize: 13 }}>
                    <strong>{rej.recipientName}</strong> <span className="muted">(1099-{rej.formType})</span> — {rej.reasons.join('; ')}
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
          {!filtered.length && <tr><td colSpan={7} className="muted">{loading ? 'Loading…' : 'No payers with forms for this year.'}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
