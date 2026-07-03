/**
 * Fleet cockpit — season-wide actions with HONEST, action-aware scope. Every
 * action shows the population it will actually hit (eligibility counts), the
 * payer selection is respected by all actions (nothing silently goes firm-wide),
 * outbound/irreversible actions confirm with the count, and the run history
 * drills into per-payer results with retry-failed.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, downloadBlob } from '../api';
import { EntityPicker } from '../components/EntityPicker';
import { Paginator } from '../components/Paginator';
import { Modal } from '../components/Modal';
import { useDialogs } from '../components/Dialogs';

interface Payer { id: string; legalName: string }
interface Pending { readyToTransmit: string[]; accepted: string[]; moSource: string[]; unmailedPaper: string[]; undeliveredElectronic: string[]; missingW9: string[]; uninvited: string[] }
interface RunItem { payerId?: string; label: string; ok: boolean; message?: string }
interface Run { id: string; kind: string; taxYear: number; status: string; total: number; succeeded: number; failed: number; items: RunItem[] | null; resultBlobId: string | null; createdAt: string }
interface Eligibility { transmit: { payers: number; records: number }; summaries: { payers: number }; invite: { uninvited: number }; w9: { missing: number } }

export function Fleet() {
  const dialogs = useDialogs();
  const [payers, setPayers] = useState<Payer[]>([]);
  const [payerIds, setPayerIds] = useState<string[]>([]);
  const [taxYear, setTaxYear] = useState(2026);
  const [elig, setElig] = useState<Eligibility | null>(null);
  const [preview, setPreview] = useState<{ items: RunItem[]; total: number } | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runsTotal, setRunsTotal] = useState(0);
  const [runsOffset, setRunsOffset] = useState(0);
  const [drill, setDrill] = useState<Run | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const RLIMIT = 25;

  const loadRuns = (off = 0) => api.get<{ runs: Run[]; total: number }>(`/api/runs?limit=${RLIMIT}&offset=${off}`).then((r) => { setRuns(r.runs); setRunsTotal(r.total); setRunsOffset(off); });
  const loadElig = useCallback(() => {
    api.post<Eligibility>('/api/runs/eligibility', { payerIds, taxYear }).then(setElig).catch(() => {});
  }, [payerIds, taxYear]);
  const loadPending = useCallback(() => { api.get<Pending>(`/api/payers/pending/${taxYear}`).then(setPending).catch(() => {}); }, [taxYear]);
  useEffect(() => {
    api.get<{ payers: Payer[] }>('/api/payers?limit=1000').then((r) => setPayers(r.payers));
    void loadRuns(0);
    const t = setInterval(() => loadRuns(runsOffset), 8000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { loadElig(); loadPending(); }, [loadElig, loadPending]);

  const scope = () => ({ payerIds, taxYear });
  const done = (msg: string) => { dialogs.toast(msg, 'success'); loadRuns(0); loadElig(); loadPending(); };
  const fail = (err: unknown) => setError(err instanceof ApiError ? err.message : String(err));
  const guardScope = () => { if (!payerIds.length) { setError('Add entities first — search or use an “add all …” button below.'); return false; } setError(''); return true; };
  const wrap = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); } catch (e) { fail(e); } finally { setBusy(false); } };
  const scopeLabel = `${payerIds.length} selected payer(s)`;

  const previewTransmit = () => { if (!guardScope()) return; return wrap(async () => { setPreview(await api.post('/api/runs/transmit/preview', scope())); }); };
  const runTransmit = () => { if (!guardScope()) return; return wrap(async () => {
    if (!(await dialogs.confirm(`Transmit ${elig?.transmit.records ?? 0} queued record(s) across ${elig?.transmit.payers ?? 0} payer(s) to the IRS? Files real (or ATS) returns.`, { title: 'Transmit all queued', danger: true }))) return;
    await api.post('/api/runs/transmit', scope()); setPreview(null); done('Transmit run started — watch run history & notifications.');
  }); };
  const runSummaries = () => { if (!guardScope()) return; return wrap(async () => {
    if (!(await dialogs.confirm(`Generate one merged summary PDF for ${elig?.summaries.payers ?? 0} of the selected payer(s) with accepted forms?`, { title: 'Generate summaries' }))) return;
    await api.post('/api/runs/summary', scope()); done('Generating merged summary PDF — appears in run history when ready.');
  }); };
  const inviteAll = () => { if (!guardScope()) return; return wrap(async () => {
    if (!(await dialogs.confirm(`Send client invites to the uninvited of ${scopeLabel}? This emails/texts clients.`, { title: 'Invite campaign' }))) return;
    const r = await api.post<{ sent: number; skipped: number; noContact: number }>('/api/invites/bulk', { payerIds, taxYear });
    done(`Invite campaign: ${r.sent} sent, ${r.skipped} already invited, ${r.noContact} without contact.`);
  }); };
  const resendInvites = () => { if (!guardScope()) return; return wrap(async () => {
    if (!(await dialogs.confirm(`Resend outstanding invites for ${scopeLabel}? This re-emails clients who haven't submitted.`, { title: 'Resend outstanding' }))) return;
    const r = await api.post<{ resent: number; outstanding: number }>('/api/invites/resend-outstanding', { taxYear, payerIds });
    done(`Resent ${r.resent} of ${r.outstanding} outstanding.`);
  }); };
  const w9Campaign = () => { if (!guardScope()) return; return wrap(async () => {
    if (!(await dialogs.confirm(`Send W-9 requests to ${elig?.w9.missing ?? 0} recipient(s) missing/stale W-9 in ${scopeLabel}? This emails/texts them.`, { title: 'W-9 campaign' }))) return;
    const r = await api.post<{ requested: number; eligible: number; more: boolean }>('/api/w9/campaign', { payerIds, taxYear });
    done(`W-9 campaign: ${r.requested} sent (${r.eligible} eligible${r.more ? ', more remain — run again' : ''}).`);
  }); };
  const downloadRun = async (r: Run) => downloadBlob(await api.get<Blob>(`/api/runs/${r.id}/download`), `filing-summaries-${r.taxYear}.pdf`);
  const retryFailed = (r: Run) => wrap(async () => { await api.post(`/api/runs/${r.id}/retry`, {}); setDrill(null); done('Retry run started for the failed payers.'); });

  const Count = ({ n, unit }: { n: number | undefined; unit: string }) => <span className="muted"> · {n ?? '…'} {unit}</span>;

  return (
    <div>
      <h1>Fleet operations</h1>
      <p className="muted">Season-wide actions. Every action targets the population shown — the payer selection below scopes them all (nothing silently goes firm-wide). Transmit is dry-run-previewed and reviewer-gated.</p>
      {error && <div className="error-box" onClick={() => setError('')}>{error}</div>}

      {/* fleet status strip — firm-wide pipeline state */}
      {pending && (
        <div className="panel" style={{ padding: '8px 14px' }}>
          <div className="row" style={{ gap: 20, alignItems: 'center' }}>
            <span className="group-label">Fleet status (firm-wide)</span>
            <span>Ready to transmit: <strong style={{ color: pending.readyToTransmit.length ? 'var(--warn)' : 'var(--ok)' }}>{pending.readyToTransmit.length}</strong></span>
            <span>Uninvited: <strong>{pending.uninvited.length}</strong></span>
            <span>Missing W-9: <strong style={{ color: pending.missingW9.length ? 'var(--warn)' : undefined }}>{pending.missingW9.length}</strong></span>
            <span>Accepted: <strong>{pending.accepted.length}</strong></span>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="row" style={{ marginBottom: 8 }}>
          <div className="field"><label>Tax year</label>
            <select value={taxYear} onChange={(e) => { setTaxYear(Number(e.target.value)); setPayerIds([]); }}><option value={2026}>2026</option><option value={2025}>2025</option></select></div>
        </div>
        <label>Working list — add the entities to act on</label>
        <EntityPicker
          options={payers.map((p) => ({ value: p.id, label: p.legalName }))}
          selected={payerIds}
          onChange={setPayerIds}
          unit="payers"
          quickAdds={pending ? [
            { label: 'Ready to transmit', ids: pending.readyToTransmit, title: 'Payers with queued records' },
            { label: 'Uninvited', ids: pending.uninvited },
            { label: 'Missing W-9', ids: pending.missingW9, title: 'Payers with recipients missing/stale W-9' },
            { label: 'With accepted', ids: pending.accepted },
            { label: 'All payers', ids: payers.map((p) => p.id) },
          ] : []}
        />
      </div>

      <div className="stat-row">
        <div className="panel" style={{ flex: 1, minWidth: 280 }}>
          <h2 style={{ marginTop: 0 }}>Collect <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>— sends emails/SMS to clients</span></h2>
          <div className="actionbar">
            <button disabled={busy} onClick={inviteAll}>Invite uninvited<Count n={elig?.invite.uninvited} unit="clients" /></button>
            <button className="secondary" disabled={busy} onClick={resendInvites}>Resend outstanding</button>
          </div>
          <div style={{ marginTop: 8 }}>
            <button className="secondary" disabled={busy} onClick={w9Campaign}>W-9 campaign<Count n={elig?.w9.missing} unit="missing" /></button>
          </div>
        </div>
        <div className="panel" style={{ flex: 1, minWidth: 280 }}>
          <h2 style={{ marginTop: 0 }}>File to IRS <span className="badge err" style={{ marginLeft: 6 }}>irreversible</span></h2>
          <div className="actionbar">
            <button className="secondary" disabled={busy} onClick={previewTransmit}>Preview transmit<Count n={elig?.transmit.records} unit="records" /></button>
            <button disabled={busy || !preview} onClick={runTransmit} title={!preview ? 'Preview first' : ''}>Transmit all queued →</button>
          </div>
          <h2 style={{ marginBottom: 4 }}>Reports</h2>
          <button className="secondary" disabled={busy} onClick={runSummaries}>Generate summary PDFs<Count n={elig?.summaries.payers} unit="payers" /></button>
        </div>
      </div>

      {preview && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Transmit dry-run — {preview.total} record(s) across {preview.items.length} payer(s)</h2>
          <table className="grid">
            <thead><tr><th>Payer</th><th>To transmit</th></tr></thead>
            <tbody>{preview.items.map((it, i) => <tr key={i}><td>{it.label}</td><td>{it.message}</td></tr>)}
              {!preview.items.length && <tr><td colSpan={2} className="muted">No queued records for the scope.</td></tr>}</tbody>
          </table>
        </div>
      )}

      <h2>Run history</h2>
      <table className="grid">
        <thead><tr><th>Kind</th><th>Year</th><th>Status</th><th className="num">OK</th><th className="num">Failed</th><th>When</th><th></th></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td><a style={{ cursor: 'pointer' }} onClick={() => setDrill(r)}>{r.kind.replace('_', ' ')}</a></td>
              <td>{r.taxYear}</td>
              <td><span className={`badge ${r.status === 'completed' ? 'ok' : r.status === 'failed' ? 'err' : r.status === 'partial' ? 'warn' : 'ready'}`}>{r.status}</span></td>
              <td className="num">{r.succeeded}</td>
              <td className="num" style={{ color: r.failed ? 'var(--danger)' : undefined }}>{r.failed}</td>
              <td>{new Date(r.createdAt).toLocaleString()}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {r.resultBlobId && <button className="small secondary" onClick={() => downloadRun(r)}>Download</button>}
                {(r.failed > 0 || (r.items && r.items.length)) && <button className="small secondary" onClick={() => setDrill(r)}>Details</button>}
              </td>
            </tr>
          ))}
          {!runs.length && <tr><td colSpan={7} className="muted">No runs yet.</td></tr>}
        </tbody>
      </table>
      <Paginator total={runsTotal} limit={RLIMIT} offset={runsOffset} onChange={(o) => loadRuns(o)} unit="runs" />

      {drill && (
        <Modal title={`${drill.kind.replace('_', ' ')} — ${drill.succeeded} ok / ${drill.failed} failed`} width={640} onClose={() => setDrill(null)}>
          {drill.failed > 0 && ['transmit', 'summary_zip'].includes(drill.kind) && (
            <div className="row" style={{ marginBottom: 8 }}>
              <button disabled={busy} onClick={() => retryFailed(drill)}>Retry {drill.failed} failed payer(s)</button>
            </div>
          )}
          <table className="grid">
            <thead><tr><th>Payer</th><th>Result</th><th>Detail</th></tr></thead>
            <tbody>
              {(drill.items ?? []).map((it, i) => (
                <tr key={i}>
                  <td>{it.label}</td>
                  <td><span className={`badge ${it.ok ? 'ok' : 'err'}`}>{it.ok ? 'ok' : 'failed'}</span></td>
                  <td className="muted">{it.message}</td>
                </tr>
              ))}
              {!(drill.items ?? []).length && <tr><td colSpan={3} className="muted">No per-payer detail.</td></tr>}
            </tbody>
          </table>
        </Modal>
      )}
    </div>
  );
}
