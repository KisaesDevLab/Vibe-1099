import { useEffect, useState } from 'react';
import { api, ApiError, formatCents, parseCentsInput } from '../api';

interface FormRow {
  id: string;
  payerId: string;
  taxYear: number;
  formType: string;
  status: string;
  boxValues: Record<string, number | boolean | string | null>;
  correctionSeq: number;
  correctionType: string | null;
  recipient: { name1: string; tinMasked: string } | null;
}

interface DiffEntry { field: string; before: unknown; after: unknown }

export function Corrections() {
  const [accepted, setAccepted] = useState<FormRow[]>([]);
  const [outstanding, setOutstanding] = useState<FormRow[]>([]);
  const [target, setTarget] = useState<FormRow | null>(null);
  const [mode, setMode] = useState<'amounts' | 'void' | 'identity'>('amounts');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [newRecipientId, setNewRecipientId] = useState('');
  const [reason, setReason] = useState('');
  const [diff, setDiff] = useState<{ classification: string; diff: DiffEntry[] } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = () => {
    api.get<{ forms: FormRow[] }>('/api/forms?status=accepted,accepted_with_errors&limit=500').then((r) => setAccepted(r.forms));
    api.get<{ outstanding: FormRow[] }>('/api/corrections/outstanding').then((r) => setOutstanding(r.outstanding as unknown as FormRow[]));
  };
  useEffect(() => { void load(); }, []);

  const buildRequest = () => {
    const req: Record<string, unknown> = { originalId: target!.id, reason };
    if (mode === 'void') req['voidRecord'] = true;
    else if (mode === 'amounts') {
      const boxValues: Record<string, number | boolean | string | null> = { ...target!.boxValues };
      for (const [boxId, raw] of Object.entries(edits)) {
        boxValues[boxId] = raw.trim() === '' ? null : parseCentsInput(raw);
      }
      req['boxValues'] = boxValues;
    } else if (mode === 'identity') {
      req['newRecipientId'] = newRecipientId;
      req['boxValues'] = target!.boxValues;
    }
    return req;
  };

  const previewDiff = async () => {
    setError('');
    try {
      const r = await api.post<{ classification: string; diff: DiffEntry[] }>('/api/corrections/diff', buildRequest());
      setDiff(r);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const create = async () => {
    setError('');
    try {
      const r = await api.post<{ classification: string; createdIds: string[]; moImpact: string | null }>('/api/corrections', buildRequest());
      setNotice(
        `Correction created (${r.classification}, ${r.createdIds.length} record(s)) in draft — review, mark ready, queue, and transmit as a correction.` +
          (r.moImpact ? ` MO NOTE: ${r.moImpact}` : ''),
      );
      setTarget(null); setDiff(null); setEdits({}); setReason('');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const redeliver = async (id: string) => {
    const r = await api.post<{ queued: number; note?: string }>(`/api/corrections/${id}/redeliver`);
    setNotice(r.note ?? `${r.queued} corrected notification(s) queued. Reprint paper via a new batch.`);
  };

  return (
    <div>
      <h1>Corrections</h1>
      {error && <div className="error-box">{error}</div>}
      {notice && <div className="ok-box">{notice}</div>}

      {!target && (
        <>
          <h2>Correctable (accepted) records</h2>
          <table className="grid">
            <thead><tr><th>Recipient</th><th>Form</th><th>Year</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {accepted.map((f) => (
                <tr key={f.id}>
                  <td>{f.recipient?.name1} <span className="mono muted">{f.recipient?.tinMasked}</span></td>
                  <td>1099-{f.formType}{f.correctionSeq > 0 && ` (corrected ×${f.correctionSeq})`}</td>
                  <td>{f.taxYear}</td>
                  <td><span className={`badge ${f.status}`}>{f.status}</span></td>
                  <td><button className="small" onClick={() => { setTarget(f); setDiff(null); setEdits({}); }}>Correct…</button>
                    {f.correctionType && <button className="small secondary" onClick={() => redeliver(f.id)}>Re-deliver</button>}</td>
                </tr>
              ))}
              {!accepted.length && <tr><td colSpan={5} className="muted">No accepted records to correct.</td></tr>}
            </tbody>
          </table>
        </>
      )}

      {target && (
        <div className="panel">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Correct 1099-{target.formType} TY{target.taxYear} — {target.recipient?.name1}</h2>
            <button className="small secondary" onClick={() => setTarget(null)}>Cancel</button>
          </div>

          <div className="tabs" style={{ marginTop: 12 }}>
            <button type="button" className={mode === 'amounts' ? 'active' : ''} onClick={() => setMode('amounts')}>Type 1 — wrong amounts/checkbox</button>
            <button type="button" className={mode === 'void' ? 'active' : ''} onClick={() => setMode('void')}>Type 1 — filed in error (void)</button>
            <button type="button" className={mode === 'identity' ? 'active' : ''} onClick={() => setMode('identity')}>Type 2 — wrong TIN/name</button>
          </div>

          {mode === 'amounts' && (
            <div className="row">
              {Object.entries(target.boxValues)
                .filter(([, v]) => typeof v === 'number')
                .map(([boxId, v]) => (
                  <div className="field" key={boxId}>
                    <label>{boxId} (as filed: {formatCents(v as number)})</label>
                    <input className="num" value={edits[boxId] ?? formatCents(v as number)} onChange={(e) => setEdits((d) => ({ ...d, [boxId]: e.target.value }))} />
                  </div>
                ))}
            </div>
          )}
          {mode === 'void' && <div className="warn-box">All amounts will be zeroed against the original filing (void semantics).</div>}
          {mode === 'identity' && (
            <div className="field">
              <label>Correct recipient ID (fix the TIN/name in the vault first, or add the correct recipient)</label>
              <input value={newRecipientId} onChange={(e) => setNewRecipientId(e.target.value)} placeholder="recipient uuid" />
              <p className="muted">Two-transaction correction: a zeroing record against the ORIGINAL identity plus a new original — transmitted as a linked pair.</p>
            </div>
          )}

          <div className="field">
            <label>Correction reason (workpaper trail)</label>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Client reported additional December payment" />
          </div>

          <div className="row">
            <button className="secondary" onClick={previewDiff} disabled={reason.length < 3}>Preview diff vs as-filed snapshot</button>
            {diff && <button onClick={create}>Create correction ({diff.classification})</button>}
          </div>

          {diff && (
            <table className="grid" style={{ marginTop: 10 }}>
              <thead><tr><th>Field</th><th>As filed</th><th>Corrected</th></tr></thead>
              <tbody>
                {diff.diff.map((d, i) => (
                  <tr key={i}>
                    <td>{d.field}</td>
                    <td className="mono">{typeof d.before === 'number' ? formatCents(d.before) : JSON.stringify(d.before)}</td>
                    <td className="mono">{typeof d.after === 'number' ? formatCents(d.after) : JSON.stringify(d.after)}</td>
                  </tr>
                ))}
                {!diff.diff.length && <tr><td colSpan={3} className="muted">No changes detected.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      )}

      <h2>Outstanding corrections</h2>
      <table className="grid">
        <thead><tr><th>Form</th><th>Year</th><th>Kind</th><th>Status</th></tr></thead>
        <tbody>
          {outstanding.map((f) => (
            <tr key={f.id}>
              <td>1099-{f.formType}</td>
              <td>{f.taxYear}</td>
              <td>{f.correctionType}</td>
              <td><span className={`badge ${f.status}`}>{f.status}</span></td>
            </tr>
          ))}
          {!outstanding.length && <tr><td colSpan={4} className="muted">No corrections in flight.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
