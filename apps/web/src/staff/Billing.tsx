/**
 * Billing estimate — the calculated fee per payer for a tax year, priced from
 * the admin fee schedule (Settings → Billing). Internal only: key these into
 * the firm's billing system. Server-filtered by preparer so totals stay honest.
 */
import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSort } from '../components/useSort';
import { api, downloadBlob, formatCents, formTypeLabel } from '../api';
import { useTaxYearState } from '../components/useTaxYears';
import { usePreparerFilter } from '../components/PreparerFilter';

interface BillingLine {
  formType: string;
  forms: number;
  baseFee: number;
  perFormRate: number;
  formsFee: number;
  corrections: number;
  correctionRate: number;
  correctionsFee: number;
  subtotal: number;
}
interface BillingRow {
  payerId: string;
  payerName: string;
  clientId: string | null;
  lines: BillingLine[];
  mailings: number;
  mailingRate: number;
  mailingFee: number;
  total: number;
  feePercentBp: number;
  net: number;
  percentFee: number;
}
interface BillingReport {
  taxYear: number;
  schedule: { feePercentBp?: number };
  scheduleMissing: boolean;
  rows: BillingRow[];
  grandTotal: number;
  grandNet: number;
}

const $ = (c: number) => `$${formatCents(c)}`;
const pct = (bp: number) => `${(bp / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
const sumForms = (r: BillingRow) => r.lines.reduce((s, l) => s + l.forms, 0);
const sumCorrections = (r: BillingRow) => r.lines.reduce((s, l) => s + l.corrections, 0);

export function Billing() {
  const [taxYear, setTaxYear, { years }] = useTaxYearState();
  const preparers = usePreparerFilter();
  const qs = preparers.query ? `?${preparers.query.slice(1)}` : '';
  const [report, setReport] = useState<BillingReport | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.get<BillingReport>(`/api/billing/${taxYear}${qs}`)
      .then(setReport)
      .finally(() => setLoading(false));
  }, [taxYear, qs]);

  const q = search.trim().toLowerCase();
  const rows = (report?.rows ?? []).filter(
    (r) => !q || r.payerName.toLowerCase().includes(q) || (r.clientId ?? '').toLowerCase().includes(q),
  );
  const sort = useSort(rows, {
    clientId: (r) => r.clientId,
    payer: (r) => r.payerName,
    forms: sumForms,
    corrections: sumCorrections,
    mailings: (r) => r.mailings,
    total: (r) => r.total,
    net: (r) => r.net,
  });
  const shownTotal = rows.reduce((s, r) => s + r.total, 0);
  const shownNet = rows.reduce((s, r) => s + r.net, 0);
  const feeBp = report?.schedule.feePercentBp ?? 0;

  const toggle = (id: string) =>
    setExpanded((e) => {
      const n = new Set(e);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });

  const exportCsv = async () => {
    const blob = await api.get<Blob>(`/api/billing/${taxYear}/export.csv${qs}`);
    downloadBlob(blob, `billing-${taxYear}.csv`);
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Billing</h1>
        <div className="field" style={{ maxWidth: 120 }}>
          <label>Tax year</label>
          <select value={taxYear} onChange={(e) => setTaxYear(Number(e.target.value))}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>
      <p className="muted">
        Estimated fee per payer from the {taxYear} fee schedule: a base fee per form type, a per-form fee for each
        non-draft form, a per-correction fee for each corrected form, and a mailing fee per paper Copy B sent.
        Internal estimate — not sent to clients.
        {feeBp > 0 && <> Totals include the {pct(feeBp)} fee; <strong>Net</strong> is the total before that fee — enter the net in your billing system.</>}
      </p>

      {report?.scheduleMissing && (
        <div className="panel" style={{ borderColor: 'var(--warn)', background: '#fffbeb' }}>
          No fee schedule is set for {taxYear}, so every fee shows as $0.{' '}
          <Link to="/settings?tab=billing">Set the {taxYear} fees in Settings → Billing</Link>.
        </div>
      )}

      <div className="panel" style={{ padding: '8px 14px' }}>
        <div className="row" style={{ gap: 20, alignItems: 'center' }}>
          <span className="group-label">Payers</span>
          <span><strong>{rows.length}</strong></span>
          <span>Total: <strong>{$(shownTotal)}</strong></span>
          {feeBp > 0 && <span>Net before {pct(feeBp)} fee: <strong>{$(shownNet)}</strong></span>}
          <div className="spacer" />
          <input placeholder="Search client ID or name…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 240 }} />
          <button className="secondary small" onClick={() => void exportCsv()} disabled={!report?.rows.length}>Export CSV</button>
        </div>
      </div>

      <table className="grid">
        <thead>
          <tr>
            <th style={{ width: 28 }}></th>
            {sort.th('clientId', 'Client ID')}{sort.th('payer', 'Payer')}{sort.th('forms', 'Forms')}
            {sort.th('corrections', 'Corrections')}{sort.th('mailings', 'Mailings')}{sort.th('total', 'Total')}
            {sort.th('net', feeBp > 0 ? `Net (before ${pct(feeBp)})` : 'Net')}
          </tr>
        </thead>
        <tbody>
          {sort.rows.map((r) => {
            const open = expanded.has(r.payerId);
            return (
              <Fragment key={r.payerId}>
                <tr onClick={() => toggle(r.payerId)} style={{ cursor: 'pointer' }}>
                  <td className="muted">{open ? '▾' : '▸'}</td>
                  <td className="mono">{r.clientId ?? <span className="muted">—</span>}</td>
                  <td>{r.payerName}</td>
                  <td className="num">{sumForms(r)}</td>
                  <td className="num">{sumCorrections(r)}</td>
                  <td className="num">{r.mailings}</td>
                  <td className="num">{$(r.total)}</td>
                  <td className="num"><strong>{$(r.net)}</strong></td>
                </tr>
                {open && (
                  <tr>
                    <td></td>
                    <td colSpan={7} style={{ background: 'var(--bg-subtle, #f8fafc)' }}>
                      <table className="grid" style={{ margin: 0 }}>
                        <thead>
                          <tr>
                            <th>Line</th><th className="num">Base fee</th><th className="num">Forms</th>
                            <th className="num">Corrections</th><th className="num">Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.lines.map((l) => (
                            <tr key={l.formType}>
                              <td>{formTypeLabel(l.formType)}</td>
                              <td className="num">{$(l.baseFee)}</td>
                              <td className="num">{l.forms} × {$(l.perFormRate)} = {$(l.formsFee)}</td>
                              <td className="num">{l.corrections ? `${l.corrections} × ${$(l.correctionRate)} = ${$(l.correctionsFee)}` : '—'}</td>
                              <td className="num">{$(l.subtotal)}</td>
                            </tr>
                          ))}
                          {r.mailings > 0 && (
                            <tr>
                              <td>Mailing (paper Copy B)</td>
                              <td className="num">—</td>
                              <td className="num">{r.mailings} × {$(r.mailingRate)}</td>
                              <td className="num">—</td>
                              <td className="num">{$(r.mailingFee)}</td>
                            </tr>
                          )}
                          <tr>
                            <td colSpan={4}><strong>Total</strong>{r.feePercentBp > 0 && <span className="muted"> (includes {pct(r.feePercentBp)} fee)</span>}</td>
                            <td className="num"><strong>{$(r.total)}</strong></td>
                          </tr>
                          {r.feePercentBp > 0 && (
                            <>
                              <tr>
                                <td colSpan={4} className="muted">Less {pct(r.feePercentBp)} fee (total ÷ {1 + r.feePercentBp / 10000})</td>
                                <td className="num muted">−{$(r.percentFee)}</td>
                              </tr>
                              <tr>
                                <td colSpan={4}><strong>Net — enter in billing system</strong></td>
                                <td className="num"><strong>{$(r.net)}</strong></td>
                              </tr>
                            </>
                          )}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {!sort.rows.length && (
            <tr><td colSpan={8} className="muted">{loading ? 'Loading…' : 'No billable forms for this year.'}</td></tr>
          )}
        </tbody>
        {sort.rows.length > 0 && (
          <tfoot>
            <tr>
              <td colSpan={6}><strong>Total{q ? ' (matching search)' : ''}</strong></td>
              <td className="num"><strong>{$(shownTotal)}</strong></td>
              <td className="num"><strong>{$(shownNet)}</strong></td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
