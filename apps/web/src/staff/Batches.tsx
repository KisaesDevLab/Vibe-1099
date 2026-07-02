import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError, downloadBlob } from '../api';
import { MultiSelect } from '../components/MultiSelect';

interface Batch {
  id: string;
  taxYear: number;
  label: string;
  pageCount: number;
  formCount: number;
  status: string;
  printedAt: string | null;
  createdAt: string;
}

interface Payer { id: string; legalName: string }

export function Batches() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [payers, setPayers] = useState<Payer[]>([]);
  const [payerIds, setPayerIds] = useState<string[]>([]);
  const [formTypes, setFormTypes] = useState<string[]>(['NEC']);
  const [taxYear, setTaxYear] = useState(2026);
  const [label, setLabel] = useState('');
  const [statuses, setStatuses] = useState<string[]>(['accepted', 'accepted_with_errors']);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = () => api.get<{ batches: Batch[] }>('/api/batches').then((r) => setBatches(r.batches));
  useEffect(() => {
    void load();
    api.get<{ payers: Payer[] }>('/api/payers').then((r) => { setPayers(r.payers); setPayerIds(r.payers.map((p) => p.id)); });
    const t = setInterval(load, 5000); // batch build progress
    return () => clearInterval(t);
  }, []);

  const toggle = (list: string[], setList: (v: string[]) => void, v: string) =>
    setList(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const build = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const r = await api.post<{ id: string; formCount: number; chunkCount: number }>('/api/batches', {
        taxYear, payerIds, formTypes, label, statuses,
      });
      setNotice(`Batch building: ${r.formCount} forms in ${r.chunkCount} render chunks. It appears below when built.`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const download = async (b: Batch) => {
    const blob = await api.get<Blob>(`/api/batches/${b.id}/pdf`);
    downloadBlob(blob, `${b.label}.pdf`);
  };

  const mark = async (id: string, verb: 'mark-printed' | 'mark-delivered') => {
    await api.post(`/api/batches/${id}/${verb}`);
    load();
  };

  const testPattern = async () => {
    const blob = await api.get<Blob>('/api/batches/test-pattern');
    downloadBlob(blob, 'pressure-seal-calibration.pdf');
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Paper batches (Z-fold pressure-seal)</h1>
        <button className="secondary" onClick={testPattern}>Calibration test sheet</button>
      </div>
      {error && <div className="error-box">{error}</div>}
      {notice && <div className="ok-box">{notice}</div>}

      <form className="panel" onSubmit={build}>
        <div className="row">
          <div className="field"><label>Tax year</label>
            <select value={taxYear} onChange={(e) => setTaxYear(Number(e.target.value))}>
              <option value={2026}>2026</option><option value={2025}>2025</option>
            </select></div>
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
          <div className="field">
            <label>Include statuses</label>
            <div className="row" style={{ gap: 8 }}>
              {['accepted', 'ready', 'queued', 'transmitted'].map((s) => (
                <label key={s} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 13, color: 'var(--text)' }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={statuses.includes(s)} onChange={() => toggle(statuses, setStatuses, s)} /> {s}
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="field">
          <label>Payers</label>
          <MultiSelect options={payers.map((p) => ({ value: p.id, label: p.legalName }))} selected={payerIds} onChange={setPayerIds} unit="payers" />
        </div>
        <button type="submit" disabled={!payerIds.length || !formTypes.length}>Build print-ready PDF</button>
        <p className="muted">One sheet per form, duplex (front: mailer face + form; back: instructions). Order: payer → recipient name. Sheet 1 is the manifest.</p>
      </form>

      <table className="grid">
        <thead><tr><th>Label</th><th>Year</th><th className="num">Forms</th><th className="num">Pages</th><th>Status</th><th>Created</th><th></th></tr></thead>
        <tbody>
          {batches.map((b) => (
            <tr key={b.id}>
              <td>{b.label}</td>
              <td>{b.taxYear}</td>
              <td className="num">{b.formCount}</td>
              <td className="num">{b.pageCount || '…'}</td>
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
    </div>
  );
}
