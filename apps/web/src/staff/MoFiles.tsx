import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError, downloadBlob } from '../api';
import { MultiSelect } from '../components/MultiSelect';

interface StateFile {
  id: string;
  state: string;
  taxYear: number;
  recordCount: number;
  filename: string;
  status: string;
  statusNotes: string;
  createdAt: string;
}

interface PreviewRow {
  payerId: string;
  payerName: string;
  moWithholdingId: string | null;
  included: number;
  excluded: number;
  totalPayments: string;
  totalWithheld: string;
  missingWithholdingId: boolean;
}

interface Payer { id: string; legalName: string }

export function MoFiles() {
  const [files, setFiles] = useState<StateFile[]>([]);
  const [payers, setPayers] = useState<Payer[]>([]);
  const [payerIds, setPayerIds] = useState<string[]>([]);
  const [taxYear, setTaxYear] = useState(2026);
  const [includeBelowThreshold, setIncludeBelowThreshold] = useState(false);
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [guidance, setGuidance] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = () => api.get<{ files: StateFile[] }>('/api/mo/files').then((r) => setFiles(r.files));
  useEffect(() => {
    void load();
    api.get<{ payers: Payer[] }>('/api/payers').then((r) => { setPayers(r.payers); setPayerIds(r.payers.map((p) => p.id)); });
    api.get<Record<string, string>>('/api/mo/correction-guidance').then(setGuidance).catch(() => {});
  }, []);

  const doPreview = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const r = await api.post<{ preview: PreviewRow[] }>('/api/mo/preview', { taxYear, payerIds, includeBelowThreshold });
      setPreview(r.preview);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const generate = async () => {
    setError('');
    try {
      const r = await api.post<{ id: string; filename: string; payeeCount: number }>('/api/mo/generate', { taxYear, payerIds, includeBelowThreshold });
      setNotice(`Generated ${r.filename} — ${r.payeeCount} payee record(s). Download it, then upload at mytax.mo.gov and mark it uploaded.`);
      setPreview(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}${err.details ? ': ' + JSON.stringify(err.details) : ''}` : String(err));
    }
  };

  const download = async (f: StateFile) => {
    const blob = await api.get<Blob>(`/api/mo/files/${f.id}/download`);
    downloadBlob(blob, f.filename);
  };

  const setStatus = async (id: string, status: 'uploaded' | 'accepted' | 'rejected') => {
    const notes = status === 'rejected' ? prompt('Rejection notes from MO DOR:') ?? '' : '';
    const r = await api.post<{ guidance?: string }>(`/api/mo/files/${id}/status`, { status, notes });
    if (r.guidance) setNotice(r.guidance);
    load();
  };

  const supersede = async (id: string) => {
    await api.post(`/api/mo/files/${id}/supersede`);
    setNotice('File marked superseded — fix the records and generate a new full file.');
    load();
  };

  return (
    <div>
      <h1>Missouri direct file (Pub 1220)</h1>
      {error && <div className="error-box">{error}</div>}
      {notice && <div className="ok-box">{notice}</div>}

      <form className="panel" onSubmit={doPreview}>
        <div className="row">
          <div className="field"><label>Tax year</label>
            <select value={taxYear} onChange={(e) => setTaxYear(Number(e.target.value))}>
              <option value={2026}>2026</option><option value={2025}>2025</option>
            </select></div>
          <div className="field">
            <label>$1,200 threshold</label>
            <select value={includeBelowThreshold ? '1' : '0'} onChange={(e) => setIncludeBelowThreshold(e.target.value === '1')}>
              <option value="0">Apply (default)</option>
              <option value="1">Override — include all</option>
            </select>
          </div>
          <div className="field grow">
            <label>Payers</label>
            <MultiSelect options={payers.map((p) => ({ value: p.id, label: p.legalName }))} selected={payerIds} onChange={setPayerIds} unit="payers" />
          </div>
          <button type="submit" className="secondary">Preview counts & totals</button>
        </div>
        <p className="muted">Includes MO-source records in accepted/transmitted status. Money fields carry CENTS with assumed decimal per Pub 1220 — written straight from integer-cents storage.</p>
      </form>

      {preview && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Preview</h2>
          <table className="grid">
            <thead><tr><th>Payer</th><th>MO WH ID</th><th className="num">Included</th><th className="num">Under threshold</th><th className="num">Payments</th><th className="num">MO withheld</th></tr></thead>
            <tbody>
              {preview.map((p) => (
                <tr key={p.payerId}>
                  <td>{p.payerName}{p.missingWithholdingId && <span className="badge err" style={{ marginLeft: 6 }}>missing MO WH ID</span>}</td>
                  <td>{p.moWithholdingId ?? '—'}</td>
                  <td className="num">{p.included}</td>
                  <td className="num">{p.excluded}</td>
                  <td className="num">${p.totalPayments}</td>
                  <td className="num">${p.totalWithheld}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button style={{ marginTop: 10 }} onClick={generate}>Generate .txt file</button>
        </div>
      )}

      <table className="grid">
        <thead><tr><th>File</th><th>Year</th><th className="num">Records</th><th>Status</th><th>Notes</th><th>Created</th><th></th></tr></thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.id}>
              <td className="mono">{f.filename}</td>
              <td>{f.taxYear}</td>
              <td className="num">{f.recordCount}</td>
              <td><span className={`badge ${f.status === 'accepted' ? 'ok' : f.status === 'rejected' ? 'err' : f.status === 'superseded' ? 'draft' : 'warn'}`}>{f.status}</span></td>
              <td className="muted">{f.statusNotes}</td>
              <td>{new Date(f.createdAt).toLocaleDateString()}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="small secondary" onClick={() => download(f)}>Download</button>
                {f.status === 'generated' && <button className="small" onClick={() => setStatus(f.id, 'uploaded')}>Mark uploaded</button>}
                {f.status === 'uploaded' && (
                  <>
                    <button className="small" onClick={() => setStatus(f.id, 'accepted')}>Accepted</button>
                    <button className="small danger" onClick={() => setStatus(f.id, 'rejected')}>Rejected</button>
                  </>
                )}
                {f.status === 'rejected' && <button className="small secondary" onClick={() => supersede(f.id)}>Supersede</button>}
              </td>
            </tr>
          ))}
          {!files.length && <tr><td colSpan={7} className="muted">No Missouri files generated yet.</td></tr>}
        </tbody>
      </table>

      {guidance && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>MO correction constraints</h2>
          <p><strong>Withholding errors:</strong> {guidance['withholding']}</p>
          <p><strong>Non-withholding errors:</strong> {guidance['nonWithholding']}</p>
          <p className="muted">Portal: {guidance['portal']}</p>
        </div>
      )}
    </div>
  );
}
