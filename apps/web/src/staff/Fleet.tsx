/**
 * Fleet cockpit (Phase B) — season-close in a handful of reviewed bulk actions:
 * invite campaign, W-9 campaign, transmit-all (dry-run preview → execute),
 * generate-all summaries, and a Filing Run history.
 */
import { useEffect, useState } from 'react';
import { api, ApiError, downloadBlob } from '../api';
import { MultiSelect } from '../components/MultiSelect';
import { useDialogs } from '../components/Dialogs';

interface Payer { id: string; legalName: string }
interface PreviewItem { payerId?: string; label: string; ok: boolean; message?: string }
interface Run {
  id: string; kind: string; taxYear: number; status: string; total: number; succeeded: number; failed: number;
  items: PreviewItem[] | null; resultBlobId: string | null; createdAt: string;
}

export function Fleet() {
  const dialogs = useDialogs();
  const [payers, setPayers] = useState<Payer[]>([]);
  const [payerIds, setPayerIds] = useState<string[]>([]);
  const [taxYear, setTaxYear] = useState(2026);
  const [preview, setPreview] = useState<{ items: PreviewItem[]; total: number } | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadRuns = () => api.get<{ runs: Run[] }>('/api/runs').then((r) => setRuns(r.runs));
  useEffect(() => {
    api.get<{ payers: Payer[] }>('/api/payers?limit=1000').then((r) => { setPayers(r.payers); setPayerIds(r.payers.map((p) => p.id)); });
    void loadRuns();
    const t = setInterval(loadRuns, 8000);
    return () => clearInterval(t);
  }, []);

  const scope = () => ({ payerIds, taxYear });
  const guard = () => { if (!payerIds.length) { setError('Select at least one payer'); return false; } setError(''); return true; };

  const previewTransmit = async () => {
    if (!guard()) return;
    setPreview(await api.post<{ items: PreviewItem[]; total: number }>('/api/runs/transmit/preview', scope()));
  };
  const runTransmit = async () => {
    if (!guard()) return;
    if (!(await dialogs.confirm(`Transmit all QUEUED records for ${payerIds.length} payer(s) to the IRS? This files real (or ATS) returns.`, { title: 'Transmit all queued', danger: true }))) return;
    setBusy(true);
    try {
      await api.post('/api/runs/transmit', scope());
      setNotice('Transmit run started — watch the run history and notifications.');
      setPreview(null); loadRuns();
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); } finally { setBusy(false); }
  };
  const runSummaries = async () => {
    if (!guard()) return;
    setBusy(true);
    try {
      await api.post('/api/runs/summary', scope());
      setNotice('Generating merged summary PDF for all selected payers — appears in run history when ready.');
      loadRuns();
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); } finally { setBusy(false); }
  };
  const inviteAll = async () => {
    if (!guard()) return;
    setBusy(true);
    try {
      const r = await api.post<{ sent: number; skipped: number; noContact: number }>('/api/invites/bulk', { payerIds, taxYear });
      setNotice(`Invite campaign: ${r.sent} sent, ${r.skipped} already invited, ${r.noContact} had no contact on file.`);
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); } finally { setBusy(false); }
  };
  const resendInvites = async () => {
    const r = await api.post<{ resent: number; outstanding: number }>('/api/invites/resend-outstanding', { taxYear });
    setNotice(`Resent ${r.resent} of ${r.outstanding} outstanding invites.`);
  };
  const w9Campaign = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ requested: number; skipped: number; eligible: number }>('/api/w9/campaign', {});
      setNotice(`W-9 campaign: ${r.requested} requested (${r.eligible} eligible, ${r.skipped} already open).`);
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); } finally { setBusy(false); }
  };
  const downloadRun = async (r: Run) => {
    const blob = await api.get<Blob>(`/api/runs/${r.id}/download`);
    downloadBlob(blob, `filing-summaries-${r.taxYear}.pdf`);
  };

  return (
    <div>
      <h1>Fleet operations</h1>
      <p className="muted">Run season-wide actions across all your payers at once. Transmit is dry-run-previewed and reviewer-gated; every run reports per-payer results.</p>
      {error && <div className="error-box" onClick={() => setError('')}>{error}</div>}
      {notice && <div className="ok-box" onClick={() => setNotice('')}>{notice}</div>}

      <div className="panel">
        <div className="row">
          <div className="field"><label>Tax year</label>
            <select value={taxYear} onChange={(e) => setTaxYear(Number(e.target.value))}><option value={2026}>2026</option><option value={2025}>2025</option></select></div>
          <div className="field grow"><label>Payers ({payerIds.length} of {payers.length})</label>
            <MultiSelect options={payers.map((p) => ({ value: p.id, label: p.legalName }))} selected={payerIds} onChange={setPayerIds} unit="payers" /></div>
        </div>
      </div>

      <div className="stat-row">
        <div className="panel" style={{ flex: 1, minWidth: 260 }}>
          <h2 style={{ marginTop: 0 }}>Collect</h2>
          <button disabled={busy} onClick={inviteAll}>Invite all selected clients</button>{' '}
          <button className="secondary" onClick={resendInvites}>Resend outstanding</button>
          <div style={{ marginTop: 8 }}><button className="secondary" disabled={busy} onClick={w9Campaign}>Send W-9 campaign (all missing/stale)</button></div>
        </div>
        <div className="panel" style={{ flex: 1, minWidth: 260 }}>
          <h2 style={{ marginTop: 0 }}>File & report</h2>
          <button className="secondary" onClick={previewTransmit}>Preview transmit-all</button>{' '}
          <button disabled={busy || !preview} onClick={runTransmit}>Transmit all queued → IRS</button>
          <div style={{ marginTop: 8 }}><button className="secondary" disabled={busy} onClick={runSummaries}>Generate all summary PDFs (one packet)</button></div>
        </div>
      </div>

      {preview && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Transmit dry-run — {preview.total} record(s) across {preview.items.length} payer(s)</h2>
          <table className="grid">
            <thead><tr><th>Payer</th><th>To transmit</th></tr></thead>
            <tbody>{preview.items.map((it, i) => <tr key={i}><td>{it.label}</td><td>{it.message}</td></tr>)}
              {!preview.items.length && <tr><td colSpan={2} className="muted">No queued records for the selected payers.</td></tr>}</tbody>
          </table>
        </div>
      )}

      <h2>Run history</h2>
      <table className="grid">
        <thead><tr><th>Kind</th><th>Year</th><th>Status</th><th className="num">OK</th><th className="num">Failed</th><th>When</th><th></th></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>{r.kind}</td>
              <td>{r.taxYear}</td>
              <td><span className={`badge ${r.status === 'completed' ? 'ok' : r.status === 'failed' ? 'err' : r.status === 'partial' ? 'warn' : 'ready'}`}>{r.status}</span></td>
              <td className="num">{r.succeeded}</td>
              <td className="num" style={{ color: r.failed ? 'var(--danger)' : undefined }}>{r.failed}</td>
              <td>{new Date(r.createdAt).toLocaleString()}</td>
              <td>{r.resultBlobId && <button className="small secondary" onClick={() => downloadRun(r)}>Download</button>}
                {r.failed > 0 && r.items && <span className="muted" title={r.items.filter((i) => !i.ok).map((i) => `${i.label}: ${i.message}`).join('\n')}> ⚠ hover</span>}</td>
            </tr>
          ))}
          {!runs.length && <tr><td colSpan={7} className="muted">No runs yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
