/**
 * Corrections — a filtered worklist keyed on the payer (the unit of multi-entity
 * work), plus a guided edit. Correctable records are found by payer/form/search,
 * not by scrolling every accepted filing; Type-2 uses the vault picker; amount
 * boxes show registry labels; outstanding corrections are a real queue.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, formatCents, parseCentsInput } from '../api';
import { MO_FILING_ENABLED } from '../config';
import { Combobox } from '../components/Combobox';
import { Paginator } from '../components/Paginator';
import { RecipientPicker } from '../components/RecipientPicker';
import { Modal } from '../components/Modal';
import { useDialogs } from '../components/Dialogs';

interface FormRow {
  id: string;
  payerId: string;
  taxYear: number;
  formType: string;
  status: string;
  boxValues: Record<string, number | boolean | string | null>;
  correctionSeq: number;
  correctionType: string | null;
  recipient: { id: string; name1: string; tinMasked: string } | null;
}
interface BoxMeta { id: string; boxNumber: string; label: string; kind: string }
interface DiffEntry { field: string; before: unknown; after: unknown }
interface Payer { id: string; legalName: string }
interface Outstanding { id: string; payerId: string; payerName: string; recipientName: string; taxYear: number; formType: string; correctionType: string | null; correctionSeq: number; status: string }

export function Corrections() {
  const dialogs = useDialogs();
  const [params, setParams] = useSearchParams();
  const [payers, setPayers] = useState<Payer[]>([]);
  const [accepted, setAccepted] = useState<FormRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [outstanding, setOutstanding] = useState<Outstanding[]>([]);
  const [outTotal, setOutTotal] = useState(0);
  const [outOffset, setOutOffset] = useState(0);

  const [payerFilter, setPayerFilter] = useState('');
  const [formType, setFormType] = useState('');
  const [yearFilter, setYearFilter] = useState('');
  const [taxYears, setTaxYears] = useState<number[]>([]);
  const [search, setSearch] = useState('');

  const [target, setTarget] = useState<FormRow | null>(null);
  const [registry, setRegistry] = useState<BoxMeta[]>([]);
  const [mode, setMode] = useState<'amounts' | 'void' | 'identity'>('amounts');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [newRecipient, setNewRecipient] = useState<{ id: string; name: string } | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [reason, setReason] = useState('');
  const [diff, setDiff] = useState<{ classification: string; diff: DiffEntry[] } | null>(null);
  const [error, setError] = useState('');
  const LIMIT = 100;
  const payerName = (id: string) => payers.find((p) => p.id === id)?.legalName ?? id.slice(0, 8);

  const loadList = (off = 0) => {
    const qs = new URLSearchParams({ status: 'accepted,accepted_with_errors', limit: String(LIMIT), offset: String(off) });
    if (payerFilter) qs.set('payerId', payerFilter);
    if (formType) qs.set('formType', formType);
    if (yearFilter) qs.set('taxYear', yearFilter);
    if (search) qs.set('search', search);
    return api.get<{ forms: FormRow[]; total: number }>(`/api/forms?${qs}`).then((r) => { setAccepted(r.forms); setTotal(r.total); setOffset(off); });
  };
  const loadOutstanding = (off = 0) =>
    api.get<{ outstanding: Outstanding[]; total: number }>(
      `/api/corrections/outstanding?limit=${LIMIT}&offset=${off}${payerFilter ? `&payerId=${payerFilter}` : ''}${yearFilter ? `&taxYear=${yearFilter}` : ''}`,
    ).then((r) => { setOutstanding(r.outstanding); setOutTotal(r.total); setOutOffset(off); });

  useEffect(() => {
    api.get<{ payers: Payer[] }>('/api/payers?limit=1000').then((r) => setPayers(r.payers));
    api.get<{ years: number[] }>('/api/admin/tax-years').then((r) => setTaxYears(r.years)).catch(() => {});
  }, []);
  useEffect(() => { void loadList(0); void loadOutstanding(0); }, [payerFilter, formType, yearFilter]);

  // deep-link: /corrections?formId=… opens the correction flow for that record
  useEffect(() => {
    const fid = params.get('formId');
    if (!fid) return;
    api.get<{ forms: FormRow[] }>('/api/forms?status=accepted,accepted_with_errors&limit=1000').then((r) => {
      const f = r.forms.find((x) => x.id === fid);
      if (f) openCorrect(f);
      setParams((p) => { p.delete('formId'); return p; }, { replace: true });
    }).catch(() => {});
  }, [params]);

  const openCorrect = (f: FormRow) => {
    setTarget(f); setDiff(null); setEdits({}); setNewRecipient(null); setMode('amounts'); setReason('');
    api.get<{ forms: Array<{ formType: string; boxes: BoxMeta[] }> }>(`/api/forms/registry/${f.taxYear}`)
      .then((r) => setRegistry(r.forms.find((x) => x.formType === f.formType)?.boxes ?? []))
      .catch(() => setRegistry([]));
  };
  const boxLabel = (boxId: string) => { const b = registry.find((x) => x.id === boxId); return b ? `Box ${b.boxNumber} — ${b.label}` : boxId; };

  const buildRequest = () => {
    const req: Record<string, unknown> = { originalId: target!.id, reason };
    if (mode === 'void') req['voidRecord'] = true;
    else if (mode === 'amounts') {
      const boxValues: Record<string, number | boolean | string | null> = { ...target!.boxValues };
      for (const [boxId, raw] of Object.entries(edits)) boxValues[boxId] = raw.trim() === '' ? null : parseCentsInput(raw);
      req['boxValues'] = boxValues;
    } else if (mode === 'identity') {
      req['newRecipientId'] = newRecipient?.id;
      req['boxValues'] = target!.boxValues;
    }
    return req;
  };

  const previewDiff = async () => {
    setError('');
    try { setDiff(await api.post<{ classification: string; diff: DiffEntry[] }>('/api/corrections/diff', buildRequest())); }
    catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
  };
  const create = async () => {
    setError('');
    try {
      const r = await api.post<{ classification: string; createdIds: string[]; moImpact: string | null }>('/api/corrections', buildRequest());
      dialogs.toast(`Correction created (${r.classification}, ${r.createdIds.length} record(s)) — review, queue, transmit.`, 'success');
      if (MO_FILING_ENABLED && r.moImpact) await dialogs.alert(r.moImpact, 'Missouri impact');
      setTarget(null); loadList(offset); loadOutstanding(outOffset);
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
  };
  const redeliver = async (id: string) => {
    const r = await api.post<{ queued: number; note?: string }>(`/api/corrections/${id}/redeliver`);
    dialogs.toast(r.note ?? `${r.queued} corrected notification(s) queued.`, 'success');
  };

  const numericBoxes = useMemo(() => target ? Object.entries(target.boxValues).filter(([, v]) => typeof v === 'number') : [], [target]);

  return (
    <div>
      <h1>Corrections</h1>
      {error && <div className="error-box" onClick={() => setError('')}>{error}</div>}

      {/* worklist filters — payer is the primary axis */}
      <div className="panel">
        <div className="row">
          <div className="field grow"><label>Payer</label>
            <Combobox options={payers.map((p) => ({ value: p.id, label: p.legalName }))} value={payerFilter} onChange={setPayerFilter} placeholder="All payers — type to filter…" allowEmpty />
          </div>
          <div className="field"><label>Form type</label>
            <select value={formType} onChange={(e) => setFormType(e.target.value)}>
              <option value="">All</option>{['NEC', 'MISC', 'INT', 'DIV'].map((t) => <option key={t} value={t}>1099-{t}</option>)}
            </select></div>
          <div className="field"><label>Tax year</label>
            <select value={yearFilter} onChange={(e) => setYearFilter(e.target.value)}>
              <option value="">All</option>{taxYears.map((y) => <option key={y} value={y}>{y}</option>)}
            </select></div>
          <div className="field grow"><label>Recipient search</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && loadList(0)} placeholder="name or last-4…" /></div>
          <button className="secondary" onClick={() => loadList(0)}>Search</button>
        </div>
      </div>

      <h2>Correctable (accepted) records</h2>
      <table className="grid">
        <thead><tr><th>Payer</th><th>Recipient</th><th>Form</th><th>Year</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {accepted.map((f) => (
            <tr key={f.id}>
              <td>{payerName(f.payerId)}</td>
              <td>{f.recipient?.name1} <span className="mono muted">{f.recipient?.tinMasked}</span></td>
              <td>1099-{f.formType}{f.correctionSeq > 0 && ` (corr ×${f.correctionSeq})`}</td>
              <td>{f.taxYear}</td>
              <td><span className={`badge ${f.status}`}>{f.status}</span></td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="small" onClick={() => openCorrect(f)}>Correct…</button>
                {f.correctionType && <button className="small secondary" onClick={() => redeliver(f.id)}>Re-deliver</button>}
              </td>
            </tr>
          ))}
          {!accepted.length && <tr><td colSpan={6} className="muted">No accepted records match. Adjust the filters.</td></tr>}
        </tbody>
      </table>
      <Paginator total={total} limit={LIMIT} offset={offset} onChange={(o) => loadList(o)} unit="records" />

      {/* outstanding corrections — a real queue with payer + recipient */}
      <h2 style={{ marginTop: 20 }}>Outstanding corrections</h2>
      <table className="grid">
        <thead><tr><th>Payer</th><th>Recipient</th><th>Form</th><th>Kind</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {outstanding.map((f) => (
            <tr key={f.id}>
              <td>{f.payerName}</td>
              <td>{f.recipientName}</td>
              <td>1099-{f.formType} TY{f.taxYear}</td>
              <td>{f.correctionType?.replace(/_/g, ' ')}</td>
              <td><span className={`badge ${f.status}`}>{f.status}</span></td>
              <td>{['accepted', 'accepted_with_errors'].includes(f.status) && <button className="small secondary" onClick={() => redeliver(f.id)}>Re-deliver</button>}</td>
            </tr>
          ))}
          {!outstanding.length && <tr><td colSpan={6} className="muted">No corrections in flight.</td></tr>}
        </tbody>
      </table>
      <Paginator total={outTotal} limit={LIMIT} offset={outOffset} onChange={(o) => loadOutstanding(o)} unit="corrections" />

      {/* --- guided correction modal --- */}
      {target && (
        <Modal title={`Correct 1099-${target.formType} TY${target.taxYear} — ${target.recipient?.name1} (${payerName(target.payerId)})`} width={720} onClose={() => setTarget(null)}>
          <div className="tabs">
            <button type="button" className={mode === 'amounts' ? 'active' : ''} onClick={() => setMode('amounts')}>Type 1 — wrong amounts</button>
            <button type="button" className={mode === 'void' ? 'active' : ''} onClick={() => setMode('void')}>Type 1 — filed in error</button>
            <button type="button" className={mode === 'identity' ? 'active' : ''} onClick={() => setMode('identity')}>Type 2 — wrong TIN/name</button>
          </div>

          {mode === 'amounts' && (
            <div className="row">
              {numericBoxes.map(([boxId, v]) => (
                <div className="field" key={boxId} style={{ minWidth: 200 }}>
                  <label>{boxLabel(boxId)} <span className="muted">(as filed {formatCents(v as number)})</span></label>
                  <input className="num" value={edits[boxId] ?? formatCents(v as number)} onChange={(e) => setEdits((d) => ({ ...d, [boxId]: e.target.value }))} />
                </div>
              ))}
              {!numericBoxes.length && <p className="muted">This form has no numeric boxes to adjust.</p>}
            </div>
          )}
          {mode === 'void' && <div className="warn-box">All amounts will be zeroed against the original filing (void semantics).</div>}
          {mode === 'identity' && (
            <div className="field" style={{ position: 'relative' }}>
              <label>Correct recipient</label>
              {newRecipient
                ? <div className="ok-box">Will re-file under <strong>{newRecipient.name}</strong>. <button className="small secondary" onClick={() => setNewRecipient(null)}>change</button></div>
                : <button className="secondary" onClick={() => setShowPicker(true)}>Choose the correct recipient from the vault…</button>}
              {showPicker && <RecipientPicker onPick={(id, name) => { setNewRecipient({ id, name }); setShowPicker(false); }} onClose={() => setShowPicker(false)} />}
              <p className="muted">Two-transaction correction: a zeroing record against the ORIGINAL identity plus a new original — transmitted as a linked pair.</p>
            </div>
          )}

          <div className="field"><label>Correction reason (workpaper trail)</label>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Client reported additional December payment" /></div>

          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="secondary" onClick={() => setTarget(null)}>Cancel</button>
            <button className="secondary" onClick={previewDiff} disabled={reason.length < 3 || (mode === 'identity' && !newRecipient)}>Preview diff</button>
            {diff && <button onClick={create}>Create correction ({diff.classification})</button>}
          </div>

          {diff && (
            <table className="grid" style={{ marginTop: 10 }}>
              <thead><tr><th>Field</th><th>As filed</th><th>Corrected</th></tr></thead>
              <tbody>
                {diff.diff.map((d, i) => (
                  <tr key={i}>
                    <td>{boxLabel(d.field)}</td>
                    <td className="mono">{typeof d.before === 'number' ? formatCents(d.before) : JSON.stringify(d.before)}</td>
                    <td className="mono">{typeof d.after === 'number' ? formatCents(d.after) : JSON.stringify(d.after)}</td>
                  </tr>
                ))}
                {!diff.diff.length && <tr><td colSpan={3} className="muted">No changes detected.</td></tr>}
              </tbody>
            </table>
          )}
        </Modal>
      )}
    </div>
  );
}
