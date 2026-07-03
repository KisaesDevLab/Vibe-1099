/**
 * Paper batches — entity-oriented builder. Payer selection starts empty and is
 * searchable; a live per-payer preview shows what will print before you commit
 * paper; build one combined batch OR one batch per payer; status filters live
 * under Advanced. History is paginated with a drill-in for reprint-single.
 */
import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError, downloadBlob } from '../api';
import { EntityPicker } from '../components/EntityPicker';
import { Paginator } from '../components/Paginator';
import { Modal } from '../components/Modal';
import { useDialogs } from '../components/Dialogs';

interface Pending { unmailedPaper: string[]; accepted: string[] }

interface Batch {
  id: string; taxYear: number; label: string; pageCount: number; formCount: number; status: string; printedAt: string | null; createdAt: string;
}
interface Payer { id: string; legalName: string }
interface PerPayer { payerId: string; payerName: string; n: number }
interface BatchForm { id: string; formType: string; recipientName: string; payerName: string }

export function Batches() {
  const dialogs = useDialogs();
  const [batches, setBatches] = useState<Batch[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [payers, setPayers] = useState<Payer[]>([]);
  const [payerIds, setPayerIds] = useState<string[]>([]);
  const [formTypes, setFormTypes] = useState<string[]>(['NEC', 'MISC', 'INT', 'DIV']);
  const [taxYear, setTaxYear] = useState(2026);
  const [label, setLabel] = useState('');
  const [statuses, setStatuses] = useState<string[]>(['accepted', 'accepted_with_errors']);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [perPayer, setPerPayer] = useState(false);
  const [preview, setPreview] = useState<{ perPayer: PerPayer[]; total: number } | null>(null);
  const [drill, setDrill] = useState<{ batch: Batch; forms: BatchForm[] } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const LIMIT = 50;

  const load = (off = 0) => api.get<{ batches: Batch[]; total: number }>(`/api/batches?limit=${LIMIT}&offset=${off}`).then((r) => { setBatches(r.batches); setTotal(r.total); setOffset(off); });
  useEffect(() => {
    void load(0);
    api.get<{ payers: Payer[] }>('/api/payers?limit=1000').then((r) => setPayers(r.payers));
    const t = setInterval(() => load(offset), 5000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { api.get<Pending>(`/api/payers/pending/${taxYear}`).then(setPending).catch(() => {}); }, [taxYear]);

  const toggle = (list: string[], setList: (v: string[]) => void, v: string) => setList(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const scope = () => ({ taxYear, payerIds, formTypes, statuses });

  const runPreview = async () => {
    setError('');
    if (!payerIds.length || !formTypes.length) { setError('Select at least one payer and form type'); return; }
    try { setPreview(await api.post<{ perPayer: PerPayer[]; total: number }>('/api/batches/preview', scope())); }
    catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
  };

  const build = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (perPayer) {
        const targets = preview?.perPayer ?? payerIds.map((id) => ({ payerId: id, payerName: '', n: 0 }));
        let built = 0;
        for (const p of targets) {
          const r = await api.post<{ id: string; formCount: number }>('/api/batches', { taxYear, payerIds: [p.payerId], formTypes, statuses, label: `${label || 'Batch'} — ${p.payerName || 'payer'}` });
          if (r.formCount) built++;
        }
        dialogs.toast(`Started ${built} per-payer batch(es). They appear below as they build.`, 'success');
      } else {
        const r = await api.post<{ formCount: number; chunkCount: number }>('/api/batches', { ...scope(), label });
        dialogs.toast(`Batch building: ${r.formCount} forms in ${r.chunkCount} chunk(s).`, 'success');
      }
      setPreview(null); load(0);
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); } finally { setBusy(false); }
  };

  const download = async (b: Batch) => { downloadBlob(await api.get<Blob>(`/api/batches/${b.id}/pdf`), `${b.label}.pdf`); };
  const mark = async (id: string, verb: 'mark-printed' | 'mark-delivered') => { await api.post(`/api/batches/${id}/${verb}`); load(offset); };
  const openDrill = async (b: Batch) => { const r = await api.get<{ forms: BatchForm[] }>(`/api/batches/${b.id}/forms`); setDrill({ batch: b, forms: r.forms }); };
  const reprintOne = async (formId: string, name: string) => { downloadBlob(await api.get<Blob>(`/api/batches/preview/zfold/${formId}`), `reprint-${name}.pdf`); };
  const testPattern = async () => { downloadBlob(await api.get<Blob>('/api/batches/test-pattern'), 'pressure-seal-calibration.pdf'); };

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Paper batches (Z-fold pressure-seal)</h1>
        <button className="secondary" onClick={testPattern}>Calibration test sheet</button>
      </div>
      {error && <div className="error-box" onClick={() => setError('')}>{error}</div>}

      <form className="panel" onSubmit={build}>
        <div className="row">
          <div className="field"><label>Tax year</label>
            <select value={taxYear} onChange={(e) => setTaxYear(Number(e.target.value))}><option value={2026}>2026</option><option value={2025}>2025</option></select></div>
          <div className="field grow"><label>Label</label><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="January mailing" /></div>
          <div className="field">
            <label>Form types</label>
            <div className="row" style={{ gap: 8 }}>
              {['NEC', 'MISC', 'INT', 'DIV'].map((t) => (
                <label key={t} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 13, color: 'var(--text)' }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={formTypes.includes(t)} onChange={() => toggle(formTypes, setFormTypes, t)} /> {t}
                </label>
              ))}
            </div>
          </div>
          <div className="field"><label>Output</label>
            <select value={perPayer ? 'per' : 'combined'} onChange={(e) => setPerPayer(e.target.value === 'per')}>
              <option value="combined">One combined batch</option>
              <option value="per">One batch per payer</option>
            </select></div>
        </div>
        <div className="field">
          <label>Payers to mail <span className="muted">(search & add, or use “add all …”)</span></label>
          <EntityPicker
            options={payers.map((p) => ({ value: p.id, label: p.legalName }))}
            selected={payerIds}
            onChange={(v) => { setPayerIds(v); setPreview(null); }}
            unit="payers"
            quickAdds={pending ? [
              { label: 'Unmailed (accepted, no paper sent)', ids: pending.unmailedPaper },
              { label: 'All with accepted forms', ids: pending.accepted },
            ] : []}
          />
        </div>

        <div className="row" style={{ alignItems: 'center' }}>
          <button type="button" className="secondary" onClick={runPreview} disabled={!payerIds.length}>Preview what will print</button>
          <button type="submit" disabled={busy || !payerIds.length || !formTypes.length || !preview}>{perPayer ? 'Build per-payer batches' : 'Build combined batch'}</button>
          <a className="muted" style={{ cursor: 'pointer' }} onClick={() => setShowAdvanced((s) => !s)}>{showAdvanced ? '− Advanced' : '+ Advanced (statuses)'}</a>
        </div>
        {showAdvanced && (
          <div className="field" style={{ marginTop: 6 }}>
            <label>Include record statuses (default: ready to mail)</label>
            <div className="row" style={{ gap: 8 }}>
              {['accepted', 'accepted_with_errors', 'ready', 'queued', 'transmitted'].map((s) => (
                <label key={s} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 13, color: 'var(--text)' }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={statuses.includes(s)} onChange={() => { toggle(statuses, setStatuses, s); setPreview(null); }} /> {s}
                </label>
              ))}
            </div>
          </div>
        )}

        {preview && (
          <div className="ok-box" style={{ marginTop: 8 }}>
            <strong>{preview.total} form(s)</strong> across <strong>{preview.perPayer.length} payer(s)</strong> — {perPayer ? `${preview.perPayer.length} separate batches` : 'one combined batch'}, ~{preview.total} sheets.
            <table className="grid" style={{ marginTop: 6 }}>
              <thead><tr><th>Payer</th><th className="num">Forms</th></tr></thead>
              <tbody>{preview.perPayer.map((p) => <tr key={p.payerId}><td>{p.payerName}</td><td className="num">{p.n}</td></tr>)}
                {!preview.perPayer.length && <tr><td colSpan={2} className="muted">No forms match — check statuses/form types.</td></tr>}</tbody>
            </table>
          </div>
        )}
        <p className="muted">One sheet per form, duplex (front: mailer + form; back: instructions). Order: payer → recipient. Sheet 1 is the manifest.</p>
      </form>

      <table className="grid">
        <thead><tr><th>Label</th><th>Year</th><th className="num">Forms</th><th className="num">Pages</th><th>Status</th><th>Created</th><th></th></tr></thead>
        <tbody>
          {batches.map((b) => (
            <tr key={b.id}>
              <td><a style={{ cursor: 'pointer' }} onClick={() => openDrill(b)}>{b.label}</a></td>
              <td>{b.taxYear}</td>
              <td className="num">{b.formCount}</td>
              <td className="num">{b.status === 'building' ? '…' : (b.pageCount || '—')}</td>
              <td><span className={`badge ${b.status === 'built' ? 'ready' : b.status === 'printed' ? 'accepted' : b.status === 'failed' ? 'err' : b.status === 'delivered' ? 'ok' : 'queued'}`}>{b.status}</span></td>
              <td>{new Date(b.createdAt).toLocaleString()}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {['built', 'printed', 'delivered'].includes(b.status) && <button className="small secondary" onClick={() => download(b)}>Download</button>}
                {b.status === 'built' && <button className="small" onClick={() => mark(b.id, 'mark-printed')}>Mark printed</button>}
                {b.status === 'printed' && <button className="small" onClick={() => mark(b.id, 'mark-delivered')}>Mark delivered</button>}
              </td>
            </tr>
          ))}
          {!batches.length && <tr><td colSpan={7} className="muted">No batches yet.</td></tr>}
        </tbody>
      </table>
      <Paginator total={total} limit={LIMIT} offset={offset} onChange={(o) => load(o)} unit="batches" />

      {drill && (
        <Modal title={`${drill.batch.label} — ${drill.forms.length} form(s)`} width={640} onClose={() => setDrill(null)}>
          <p className="muted">Reprint a single form (e.g. one that jammed in the sealer).</p>
          <table className="grid">
            <thead><tr><th>Payer</th><th>Recipient</th><th>Form</th><th></th></tr></thead>
            <tbody>
              {drill.forms.map((f) => (
                <tr key={f.id}><td>{f.payerName}</td><td>{f.recipientName}</td><td>1099-{f.formType}</td>
                  <td><button className="small secondary" onClick={() => reprintOne(f.id, f.recipientName)}>Reprint</button></td></tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
    </div>
  );
}
