/**
 * Staff grid entry (Phase 4): payer → form type → recipient rows with amount
 * columns; keyboard-first (Enter advances like Tab, ten-key friendly);
 * inline recipient add via vault lookup; status actions; rollforward.
 */
import { useCallback, useEffect, useMemo, useRef, useState, KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSort } from '../components/useSort';
import { api, ApiError, downloadBlob, formatCents, formTypeLabel, parseCentsInput, payerPdfName } from '../api';
import { Combobox } from '../components/Combobox';
import { RecipientPicker } from '../components/RecipientPicker';
import { useTaxYears } from '../components/useTaxYears';
import { ALL_ROWS, Paginator, usePageSize } from '../components/Paginator';
import { usePreparerFilter } from '../components/PreparerFilter';
import { useDialogs } from '../components/Dialogs';

interface BoxMeta { id: string; boxNumber: string; label: string; kind: string; stateField: boolean }
interface RegistryForm { formType: string; title: string; boxes: BoxMeta[]; federalThresholdCents: number | null }
interface Payer { id: string; legalName: string; clientId: string | null }
interface FormRow {
  id: string;
  recipientId: string;
  boxValues: Record<string, number | boolean | string | null>;
  accountNumber: string;
  status: string;
  moSource: boolean;
  correctionType: string | null;
  recordErrors: Array<{ code: string; message: string; translated?: string }> | null;
  /** imported filed-history (accepted, never transmitted here) — deletable to clean up a bad import */
  externallyFiled?: boolean;
  recipient: { id: string; name1: string; tinMasked: string; w9Status: string } | null;
}

export function FormsGrid() {
  const dialogs = useDialogs();
  const [params, setParams] = useSearchParams();
  const [payers, setPayers] = useState<Payer[]>([]);
  const [registry, setRegistry] = useState<RegistryForm[]>([]);
  const [rows, setRows] = useState<FormRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({}); // formId -> boxId -> raw input
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [showPicker, setShowPicker] = useState(false);
  // default All: this is a data-entry grid — a payer's whole list in one scroll
  const [limit, setLimit] = usePageSize('forms', ALL_ROWS);
  const preparers = usePreparerFilter();

  const payerId = params.get('payerId') ?? '';
  const { years: taxYears, current: currentYear } = useTaxYears();
  const taxYear = Number(params.get('taxYear') ?? currentYear);
  const formType = params.get('formType') ?? 'NEC';

  const currentDef = useMemo(() => registry.find((r) => r.formType === formType), [registry, formType]);
  const moneyBoxes = useMemo(() => (currentDef?.boxes ?? []).filter((b) => !b.stateField && b.kind === 'cents'), [currentDef]);
  const checkBoxes = useMemo(() => (currentDef?.boxes ?? []).filter((b) => !b.stateField && b.kind === 'checkbox'), [currentDef]);

  useEffect(() => {
    api.get<{ payers: Payer[] }>('/api/payers').then((r) => setPayers(r.payers));
  }, []); // initial load only

  // payer choices honor the app-wide preparer filter (the open payer always stays listed)
  const visiblePayers = useMemo(() => payers.filter((p) => preparers.matches(p.id) || p.id === payerId), [payers, preparers, payerId]);
  useEffect(() => {
    if (!payerId && visiblePayers[0]) setParams((p) => { p.set('payerId', visiblePayers[0]!.id); return p; }, { replace: true });
  }, [payerId, visiblePayers]);
  const payer = payers.find((p) => p.id === payerId);

  useEffect(() => {
    api.get<{ forms: RegistryForm[] }>(`/api/forms/registry/${taxYear}`).then((r) => setRegistry(r.forms)).catch(() => setRegistry([]));
  }, [taxYear]);

  const load = useCallback((off = 0) => {
    if (!payerId) return;
    api
      .get<{ forms: FormRow[]; total: number }>(`/api/forms?payerId=${payerId}&taxYear=${taxYear}&formType=${formType}&limit=${limit}&offset=${off}`)
      .then((r) => { setRows(r.forms); setTotal(r.total); setOffset(off); });
  }, [payerId, taxYear, formType, limit]);
  useEffect(() => { void load(0); }, [load]);

  const setParam = (key: string, value: string) => setParams((p) => { p.set(key, value); return p; });

  const editable = (status: string) => ['draft', 'ready', 'rejected'].includes(status);

  const draftValue = (row: FormRow, boxId: string): string => {
    const d = drafts[row.id]?.[boxId];
    if (d !== undefined) return d;
    const v = row.boxValues[boxId];
    return typeof v === 'number' && v > 0 ? formatCents(v) : '';
  };

  const setDraft = (formId: string, boxId: string, value: string) =>
    setDrafts((d) => ({ ...d, [formId]: { ...d[formId], [boxId]: value } }));

  // One PATCH per row at a time: Enter + focus-change both fire a commit, and a
  // second concurrent PATCH would race the first (and double the audit trail).
  const inflight = useRef(new Set<string>());

  const commitRow = async (row: FormRow) => {
    const rowDrafts = drafts[row.id];
    if (!rowDrafts || inflight.current.has(row.id)) return;
    const boxValues: Record<string, number | boolean | string | null> = { ...row.boxValues };
    try {
      for (const [boxId, raw] of Object.entries(rowDrafts)) {
        boxValues[boxId] = raw.trim() === '' ? null : parseCentsInput(raw);
      }
    } catch (err) {
      setError(String((err as Error).message));
      return;
    }
    inflight.current.add(row.id);
    try {
      const r = await api.patch<{ form: { boxValues: FormRow['boxValues']; status: string; accountNumber: string } }>(`/api/forms/${row.id}`, { boxValues });
      // merge the server's answer into the row instead of refetching the whole
      // grid (up to 1,000 rows) after every single cell commit
      setRows((rs) => rs.map((x) => (x.id === row.id ? { ...x, boxValues: r.form.boxValues, status: r.form.status, accountNumber: r.form.accountNumber } : x)));
      // Drop only the boxes this PATCH sent, and only if they were not retyped
      // while it was in flight — a value keyed into another box of the same row
      // meanwhile must survive to be committed by its own blur.
      setDrafts((d) => {
        const current = d[row.id];
        if (!current) return d;
        const rest: Record<string, string> = {};
        for (const [boxId, value] of Object.entries(current)) {
          if (rowDrafts[boxId] === undefined || rowDrafts[boxId] !== value) rest[boxId] = value;
        }
        const { [row.id]: _, ...others } = d;
        return Object.keys(rest).length ? { ...others, [row.id]: rest } : others;
      });
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}${err.details ? ': ' + JSON.stringify(err.details) : ''}` : String(err));
    } finally {
      inflight.current.delete(row.id);
    }
  };

  const toggleCheckbox = async (row: FormRow, boxId: string) => {
    if (!editable(row.status)) return;
    const boxValues = { ...row.boxValues, [boxId]: !(row.boxValues[boxId] === true) };
    await api.patch(`/api/forms/${row.id}`, { boxValues }).catch((err: ApiError) => setError(err.message));
    load();
  };

  // keyboard-first: Enter moves down the same column (ten-key entry)
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>, rowIndex: number, boxId: string, row: FormRow) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // moving focus blurs this cell, and the blur handler commits the row — do not
      // commit here as well or the same PATCH goes out twice
      const next = document.querySelector<HTMLInputElement>(`input[data-cell="${rowIndex + 1}:${boxId}"]`);
      if (next) {
        next.focus();
        next.select();
      } else {
        e.currentTarget.blur();
      }
    }
  };

  // Accepted / accepted-with-errors / corrected forms are terminal — their status
  // can only change through the correction path, so exclude them from status moves.
  const isTerminal = (s: string) => ['accepted', 'accepted_with_errors', 'corrected'].includes(s);

  const bulkStatus = async (to: 'ready' | 'queued' | 'draft') => {
    const ids = rows.filter((r) => selected.has(r.id) && !isTerminal(r.status)).map((r) => r.id);
    if (!ids.length) return setError('Select forms that aren’t already accepted — accepted forms change only via a correction.');
    const r = await api.post<{ results: Array<{ id: string; ok: boolean; error?: string }> }>('/api/forms/bulk-status', { ids, to });
    const failed = r.results.filter((x) => !x.ok);
    setNotice(`${r.results.length - failed.length} moved to ${to}${failed.length ? `; ${failed.length} failed: ${failed[0]?.error}` : ''}`);
    setSelected(new Set());
    load();
  };

  const printSelected = async (layout: 'copyb' | 'zfold' | 'client') => {
    const ids = [...selected];
    if (!ids.length) return setError('Select rows to print.');
    try {
      const blob = await api.post<Blob>('/api/batches/print', { formRecordIds: ids, layout });
      downloadBlob(blob, payerPdfName(payer?.legalName ?? '', taxYear, formType, payer?.clientId, { copyb: '', zfold: 'ZFold', client: 'ClientCopy' }[layout]));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const transmit = async () => {
    try {
      const r = await api.post<{ transmissionId: string; recordCount: number; isCorrection: boolean; skipped: number }>('/api/iris/transmit', { payerId, taxYear });
      const left = r.skipped
        ? ` ${r.skipped} ${r.isCorrection ? 'original' : 'correction'} record(s) are still queued — click Transmit again to send them as a separate ${r.isCorrection ? 'original' : 'correction'} transmission.`
        : '';
      setNotice(`${r.isCorrection ? 'Correction transmission' : 'Transmission'} queued: ${r.recordCount} record(s). Track it under IRS transmissions.${left}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}${err.details ? ': ' + JSON.stringify(err.details) : ''}` : String(err));
    }
  };

  const addRecipientRow = async (recipientId: string, name: string) => {
    setShowPicker(false);
    try {
      // an empty draft — amounts are typed in afterwards (the → ready gate enforces
      // "at least one amount"; a placeholder cent would be a transmittable $0.01 return)
      const r = await api.post<{ duplicateWarning: string | null }>('/api/forms', { payerId, recipientId, taxYear, formType, boxValues: {} });
      setNotice(r.duplicateWarning ? `Added ${name} — ${r.duplicateWarning}.` : `Added ${name} — enter amounts.`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const rollforward = async () => {
    const r = await api.post<{ created: number }>('/api/forms/rollforward', { payerId, fromYear: taxYear - 1, toYear: taxYear, formType });
    setNotice(`Rollforward created ${r.created} draft row(s) from TY${taxYear - 1} (amounts blank).`);
    load();
  };

  const deleteRow = async (row: FormRow) => {
    if (!(await dialogs.confirm(`Delete this ${row.status} form for ${row.recipient?.name1}?`, { danger: true, title: 'Delete form' }))) return;
    await api.del(`/api/forms/${row.id}`).catch((err: ApiError) => setError(err.message));
    load();
  };

  const preview = async (row: FormRow) => {
    const blob = await api.get<Blob>(`/api/batches/preview/portal/${row.id}`);
    downloadBlob(blob, payerPdfName(payer?.legalName ?? '', taxYear, formType, payer?.clientId));
  };

  const summary = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const row of rows) {
      if (row.status === 'corrected') continue;
      for (const b of moneyBoxes) {
        const v = row.boxValues[b.id];
        if (typeof v === 'number') totals[b.id] = (totals[b.id] ?? 0) + v;
      }
    }
    return totals;
  }, [rows, moneyBoxes]);


  // box columns are registry-driven, so their sort accessors are built per form type
  const sort = useSort<FormRow, string>(rows, {
    recipient: (r) => r.recipient?.name1,
    status: (r) => r.status,
    ...Object.fromEntries(moneyBoxes.map((b) => [b.id, (r: FormRow) => (typeof r.boxValues[b.id] === 'number' ? (r.boxValues[b.id] as number) : null)])),
  });

  return (
    <div>
      <h1>Form entry — {formTypeLabel(formType)} TY{taxYear}</h1>
      {error && <div className="error-box" onClick={() => setError('')}>{error}</div>}
      {notice && <div className="ok-box" onClick={() => setNotice('')}>{notice}</div>}

      {/* context selectors */}
      <div className="panel">
        <div className="row">
          <div className="field grow" style={{ position: 'relative' }}><label>Payer (type to search {visiblePayers.length})</label>
            <Combobox options={visiblePayers.map((p) => ({ value: p.id, label: p.legalName }))} value={payerId} onChange={(v) => setParam('payerId', v)} placeholder="Search payers…" /></div>
          <div className="field"><label>Tax year</label>
            <select value={taxYear} onChange={(e) => setParam('taxYear', e.target.value)}>{taxYears.map((y) => <option key={y} value={y}>{y}</option>)}</select></div>
          <div className="field"><label>Form type</label>
            <select value={formType} onChange={(e) => setParam('formType', e.target.value)}>
              {registry.map((r) => <option key={r.formType} value={r.formType}>{formTypeLabel(r.formType)}</option>)}
            </select></div>
        </div>
        {/* entry actions on the left; filing actions grouped on the right so a
            transmit can't be fat-fingered while keying amounts */}
        <div className="actionbar" style={{ marginTop: 8 }}>
          <span className="group-label">Entry</span>
          <div style={{ position: 'relative' }}>
            <button className="secondary" onClick={() => setShowPicker((s) => !s)}>+ Recipient row</button>
            {showPicker && <RecipientPicker onPick={addRecipientRow} onClose={() => setShowPicker(false)} />}
          </div>
          <button className="secondary" onClick={rollforward}>Rollforward TY{taxYear - 1}</button>
          <div className="spacer" />
          <span className="group-label">Filing {selected.size > 0 ? `(${selected.size} selected)` : ''}</span>
          {(() => {
            const selectedActionable = rows.some((r) => selected.has(r.id) && !isTerminal(r.status));
            const hasQueued = rows.some((r) => r.status === 'queued');
            return (<>
              <button className="secondary" disabled={!selectedActionable} onClick={() => bulkStatus('ready')} title={!selectedActionable ? 'Accepted forms can’t change status' : ''}>Mark ready</button>
              <button className="secondary" disabled={!selectedActionable} onClick={() => bulkStatus('queued')}>Queue</button>
              <button className="secondary" disabled={!selectedActionable} onClick={() => bulkStatus('draft')}>↩ Draft</button>
              <button className="secondary" disabled={!selected.size} onClick={() => void printSelected('copyb')} title="Print the selected forms as full Copy B pages (one form per page)">🖨 Copy B</button>
              <button className="secondary" disabled={!selected.size} onClick={() => void printSelected('zfold')} title="Print the selected forms as Z-fold pressure-seal mailer sheets">🖨 Z-fold</button>
              <button className="secondary" disabled={!selected.size} onClick={() => void printSelected('client')} title="Compact client copy for the payer's records — several forms per page, recipient TINs truncated">🖨 Client copy</button>
              <button disabled={!hasQueued} onClick={transmit} title={hasQueued ? "Transmit this payer's queued records to the IRS" : 'No queued records to transmit'}>Transmit queued →</button>
            </>);
          })()}
        </div>
      </div>

      <div className="table-scroll">
      <table className="grid">
        <thead>
          <tr>
            <th className="sticky" style={{ left: 0 }}><input type="checkbox" onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} /></th>
            {sort.th('recipient', 'Recipient', { className: 'sticky', style: { left: 34 } })}
            {moneyBoxes.map((b) => sort.th(b.id, <>{b.boxNumber || '·'} {b.label.length > 22 ? b.label.slice(0, 20) + '…' : b.label}</>, { className: 'num', title: b.label }))}
            {checkBoxes.map((b) => <th key={b.id} title={b.label}>{b.boxNumber || '·'} ☐</th>)}
            {sort.th('status', 'Status')}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sort.rows.map((row, ri) => (
            <tr key={row.id}>
              <td className="sticky" style={{ left: 0 }}><input type="checkbox" checked={selected.has(row.id)} onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) next.add(row.id); else next.delete(row.id);
                setSelected(next);
              }} /></td>
              <td className="sticky" style={{ left: 34, minWidth: 180 }}>
                {row.recipient?.name1 ?? '?'} <span className="mono muted">{row.recipient?.tinMasked}</span>
                {row.correctionType && <span className="badge corrected" style={{ marginLeft: 4 }}>CORR</span>}
                {row.recordErrors?.length ? (
                  <div className="muted" style={{ color: 'var(--danger)' }} title={row.recordErrors.map((e) => e.translated ?? e.message).join('\n')}>
                    ⚠ {row.recordErrors[0]?.translated ?? row.recordErrors[0]?.message}
                  </div>
                ) : null}
              </td>
              {moneyBoxes.map((b) => (
                <td key={b.id} className="num" style={{ padding: 2, minWidth: 90 }}>
                  <input
                    className="num"
                    data-cell={`${ri}:${b.id}`}
                    disabled={!editable(row.status)}
                    value={draftValue(row, b.id)}
                    onChange={(e) => setDraft(row.id, b.id, e.target.value)}
                    onBlur={() => commitRow(row)}
                    onKeyDown={(e) => onKeyDown(e, ri, b.id, row)}
                    inputMode="decimal"
                  />
                </td>
              ))}
              {checkBoxes.map((b) => (
                <td key={b.id} style={{ textAlign: 'center' }}>
                  <input type="checkbox" checked={row.boxValues[b.id] === true} disabled={!editable(row.status)} onChange={() => toggleCheckbox(row, b.id)} />
                </td>
              ))}
              <td><span className={`badge ${row.status}`}>{row.status}</span></td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="small secondary" onClick={() => preview(row)} title="Copy B PDF preview">PDF</button>
                {(['draft', 'ready'].includes(row.status) || row.externallyFiled) && (
                  <button className="small danger" onClick={() => deleteRow(row)} title={row.externallyFiled ? 'Imported filed history — delete to clean up a bad import' : 'Delete draft'}>✕</button>
                )}
                {row.externallyFiled && <span className="badge queued" title="Filed outside Vibe 1099 and imported as history" style={{ marginLeft: 4 }}>imported</span>}
              </td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={4 + moneyBoxes.length + checkBoxes.length} className="muted">No forms — add a row or run rollforward.</td></tr>}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr>
              <td colSpan={2}><strong>Totals ({rows.filter((r) => r.status !== 'corrected').length} forms)</strong></td>
              {moneyBoxes.map((b) => <td key={b.id} className="num"><strong>{summary[b.id] ? formatCents(summary[b.id]!) : ''}</strong></td>)}
              {checkBoxes.map((b) => <td key={b.id} />)}
              <td colSpan={2} />
            </tr>
          </tfoot>
        )}
      </table>
      </div>
      <Paginator total={total} limit={limit} offset={offset} onChange={(o) => load(o)} onLimitChange={setLimit} unit={`${formTypeLabel(formType)} forms`} />
      <p className="muted">Enter moves down the column (ten-key friendly). Amounts commit on blur/Enter. Sub-threshold NEC amounts warn but never block.</p>
    </div>
  );
}
