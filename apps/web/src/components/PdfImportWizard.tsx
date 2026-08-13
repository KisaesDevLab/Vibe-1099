/**
 * Prior-year 1099 print-PDF import wizard (Recipients screen):
 * upload -> server parse -> review/edit proposal -> import payer + recipients.
 * The server never persists anything at parse time; the import step reuses
 * POST /api/payers and POST /api/recipients/import.
 */
import { useEffect, useState } from 'react';
import { api, ApiError, parseCentsInput } from '../api';
import { Modal } from './Modal';
import { useDialogs } from './Dialogs';

interface ParsedAddress { line1: string; line2: string; city: string; state: string; zip: string }
interface ParsedParty {
  tin: string;
  tinType: 'SSN' | 'EIN' | null;
  tinMasked: boolean;
  tinLast4: string;
  name1: string;
  name2: string;
  address: ParsedAddress | null;
}
interface Proposal {
  taxYear: number | null;
  formType: 'NEC' | 'MISC' | 'INT' | 'DIV' | null;
  payer: (ParsedParty & { match: { payerId: string; legalName: string } | null }) | null;
  recipients: Array<ParsedParty & { amount: string | null; match: { recipientId: string; name1: string; tinMasked: string } | null }>;
  warnings: string[];
}

type Row = {
  include: boolean;
  tin: string;
  tinType: 'SSN' | 'EIN';
  name1: string;
  name2: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
  amount: string | null;
  matchName: string | null;
};

const fileToBase64 = (f: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

export function PdfImportWizard({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const dialogs = useDialogs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  // Data-only overlay prints (values only, for preprinted stock) carry no
  // "1099-XXX" text, so the parse can't tell the form type — the operator picks
  // it here; it becomes the created payer's default form type and the type of
  // any filed-history records created below.
  const [formType, setFormType] = useState<'' | 'NEC' | 'MISC' | 'INT' | 'DIV'>('');
  // Filed-history step: record the parsed amounts as forms already filed (by the
  // prior software) for the chosen year, so rollforward can work from them.
  const [importFiled, setImportFiled] = useState(false);
  const [taxYear, setTaxYear] = useState('');
  const [boxId, setBoxId] = useState('box1');
  const [boxes, setBoxes] = useState<Array<{ id: string; boxNumber: string; label: string }>>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [payer, setPayer] = useState({ create: false, legalName: '', tin: '', tinType: 'EIN' as 'SSN' | 'EIN', line1: '', line2: '', city: '', state: '', zip: '', matchName: null as string | null });

  const parse = async (f: File) => {
    setBusy(true);
    setError('');
    try {
      const pdf = await fileToBase64(f);
      const p = await api.post<Proposal>('/api/recipients/import/pdf', { pdf });
      setProposal(p);
      setFormType(p.formType ?? '');
      setTaxYear(p.taxYear ? String(p.taxYear) : '');
      setImportFiled(!!p.payer && p.recipients.some((r) => r.amount));
      setRows(
        p.recipients.map((r) => ({
          include: !r.match, // already-in-vault rows default to skip
          tin: r.tin,
          tinType: r.tinType ?? 'SSN',
          name1: r.name1,
          name2: r.name2,
          line1: r.address?.line1 ?? '',
          line2: r.address?.line2 ?? '',
          city: r.address?.city ?? '',
          state: r.address?.state ?? '',
          zip: r.address?.zip ?? '',
          amount: r.amount,
          matchName: r.match?.name1 ?? null,
        })),
      );
      if (p.payer) {
        setPayer({
          create: !p.payer.match,
          legalName: p.payer.name1,
          tin: p.payer.tin,
          tinType: p.payer.tinType ?? 'EIN',
          line1: p.payer.address?.line1 ?? '',
          line2: p.payer.address?.line2 ?? '',
          city: p.payer.address?.city ?? '',
          state: p.payer.address?.state ?? '',
          zip: p.payer.address?.zip ?? '',
          matchName: p.payer.match?.legalName ?? null,
        });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not read that PDF.');
    } finally {
      setBusy(false);
    }
  };

  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  // Amount-box options for the chosen form type + year (registry-driven).
  useEffect(() => {
    if (!importFiled || !formType || !/^\d{4}$/.test(taxYear)) return;
    api
      .get<{ forms: Array<{ formType: string; boxes: Array<{ id: string; boxNumber: string; label: string; kind: string; stateField?: boolean }> }> }>(
        `/api/forms/registry/${taxYear}`,
      )
      .then((r) => {
        const cents = (r.forms.find((f) => f.formType === formType)?.boxes ?? []).filter((b) => b.kind === 'cents' && !b.stateField);
        setBoxes(cents);
        setBoxId((cur) => (cents.some((b) => b.id === cur) ? cur : (cents[0]?.id ?? '')));
      })
      .catch(() => setBoxes([]));
  }, [importFiled, formType, taxYear]);

  const selected = rows.filter((r) => r.include);
  const blockers = selected.filter((r) => !r.tin || !r.name1 || !r.line1 || !r.city || r.state.length !== 2 || !r.zip);
  const payerBlocked = payer.create && (!payer.legalName || !payer.tin || !payer.line1 || !payer.city || payer.state.length !== 2 || !payer.zip);
  // Filed-history rows: every row with an amount + TIN, selected or not — a
  // recipient already in the vault (default-unselected) still gets its record.
  const filedRows = rows.filter((r) => r.amount && r.tin);
  const payerResolvable = payer.create || !!(proposal?.payer?.match);
  const filedBlocked = importFiled && (!formType || !/^\d{4}$/.test(taxYear) || !boxId || !payerResolvable || filedRows.length === 0);

  const runImport = async () => {
    setBusy(true);
    setError('');
    try {
      let payerNote = '';
      let payerId = proposal?.payer?.match?.payerId ?? null;
      if (payer.create) {
        const createdPayer = await api.post<{ id: string }>('/api/payers', {
          legalName: payer.legalName,
          tin: payer.tin,
          tinType: payer.tinType,
          address: { line1: payer.line1, line2: payer.line2, city: payer.city, state: payer.state.toUpperCase(), zip: payer.zip },
          defaultFormTypes: formType ? [formType] : undefined,
        });
        payerId = createdPayer.id;
        payerNote = `Payer "${payer.legalName}" created. `;
      }
      let recipNote = 'No recipients selected.';
      if (selected.length > 0) {
        const r = await api.post<{ created: number; updated: number; skipped: number; errors: Array<{ row: number; reason: string }> }>(
          '/api/recipients/import',
          {
            rows: selected.map((s) => ({
              tin: s.tin, tinType: s.tinType, name1: s.name1, name2: s.name2,
              line1: s.line1, line2: s.line2, city: s.city, state: s.state.toUpperCase(), zip: s.zip,
            })),
            updateExisting: false,
          },
        );
        recipNote = `Recipients: ${r.created} created, ${r.skipped} already in vault${r.errors.length ? `, ${r.errors.length} errors` : ''}.`;
        if (r.errors.length) setError(r.errors.map((e) => `Row ${e.row}: ${e.reason}`).join(' · '));
      }
      let filedNote = '';
      if (importFiled && payerId && filedRows.length > 0) {
        const f = await api.post<{ created: number; skippedExisting: number; unmatched: number[] }>('/api/forms/import-filed', {
          payerId,
          taxYear: Number(taxYear),
          formType,
          boxId,
          rows: filedRows.map((s) => ({ tin: s.tin, tinType: s.tinType, amountCents: parseCentsInput(s.amount ?? '') })),
        });
        filedNote = ` Filed TY${taxYear} records: ${f.created} created${f.skippedExisting ? `, ${f.skippedExisting} already existed` : ''}${f.unmatched.length ? `, ${f.unmatched.length} not in vault (import them first)` : ''}.`;
      }
      dialogs.toast(payerNote + recipNote + filedNote, 'success');
      onImported();
      if (!payer.create && selected.length === 0 && !filedNote) return; // nothing happened; stay open
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Import from prior-year PDF" width={980} onClose={onClose}>
      {!proposal && (
        <>
          <p className="muted">
            Upload a prior-year 1099 print PDF (NEC / MISC / INT / DIV). The forms are parsed into a payer and
            recipient list you review before anything is saved. Scanned images can’t be read — use a PDF printed
            from your filing software. Recipient copies with truncated TINs (XXX-XX-1234) parse, but you’ll need
            to fill in full TINs by hand.
          </p>
          <input
            type="file"
            accept="application/pdf,.pdf"
            disabled={busy}
            onChange={(e) => e.target.files?.[0] && void parse(e.target.files[0])}
          />
          {busy && <p className="muted">Reading PDF…</p>}
        </>
      )}

      {error && <div className="error-box">{error}</div>}

      {proposal && (
        <>
          <p className="muted">
            Parsed {proposal.formType ? `1099-${proposal.formType}` : 'unknown form type'}
            {proposal.taxYear ? ` · tax year ${proposal.taxYear}` : ''} · {proposal.recipients.length} recipient form(s).
            Amounts shown are prior-year values for eyeballing only — they are not imported.
          </p>
          <div className="panel" style={{ padding: 8, marginBottom: 8 }}>
            <label style={{ display: 'block', marginBottom: 6 }}>
              <input type="checkbox" checked={importFiled} onChange={(e) => setImportFiled(e.target.checked)} />{' '}
              Also record these amounts as <b>filed forms</b> for the year below
            </label>
            <div className="row">
              <div className="field" style={{ width: 110 }}><label>Tax year</label>
                <input value={taxYear} placeholder="e.g. 2025" onChange={(e) => setTaxYear(e.target.value.replace(/\D/g, '').slice(0, 4))} /></div>
              <div className="field"><label>Form type {!proposal.formType && <span className="muted">(the PDF doesn’t say)</span>}</label>
                <select value={formType} onChange={(e) => setFormType(e.target.value as typeof formType)}>
                  <option value="">— not set —</option>
                  <option value="NEC">1099-NEC</option>
                  <option value="MISC">1099-MISC</option>
                  <option value="INT">1099-INT</option>
                  <option value="DIV">1099-DIV</option>
                </select></div>
              {importFiled && (
                <div className="field grow"><label>Amount box</label>
                  <select value={boxId} onChange={(e) => setBoxId(e.target.value)}>
                    {boxes.map((b) => (<option key={b.id} value={b.id}>Box {b.boxNumber} — {b.label}</option>))}
                    {!boxes.length && <option value="">— pick form type + year —</option>}
                  </select></div>
              )}
            </div>
            {importFiled && (
              <p className="muted" style={{ margin: 0 }}>
                Creates <b>accepted</b> records marked “filed outside Vibe 1099” for every row with an amount ({filedRows.length} of {rows.length}),
                including recipients already in the vault. They can’t be re-transmitted or corrected from here, they seed next season’s
                rollforward, and they can be deleted if the import was wrong. The form type also becomes a new payer’s default.
              </p>
            )}
          </div>
          {proposal.warnings.length > 0 && (
            <div className="error-box" style={{ background: 'transparent' }}>
              {proposal.warnings.map((w, i) => (<div key={i}>⚠ {w}</div>))}
            </div>
          )}

          <h3 style={{ marginBottom: 4 }}>Payer</h3>
          {proposal.payer === null ? (
            <p className="muted">No payer block could be parsed — create the payer on the Payers screen first.</p>
          ) : payer.matchName && !payer.create ? (
            <p>
              <span className="badge ok">in system</span> Matches existing payer <b>{payer.matchName}</b> — nothing to create.
            </p>
          ) : (
            <div className="panel" style={{ padding: 8 }}>
              <label style={{ display: 'block', marginBottom: 6 }}>
                <input type="checkbox" checked={payer.create} onChange={(e) => setPayer({ ...payer, create: e.target.checked })} /> Create this payer
              </label>
              <div className="row">
                <div className="field grow"><label>Legal name</label>
                  <input value={payer.legalName} disabled={!payer.create} onChange={(e) => setPayer({ ...payer, legalName: e.target.value })} /></div>
                <div className="field"><label>TIN</label>
                  <input value={payer.tin} disabled={!payer.create} onChange={(e) => setPayer({ ...payer, tin: e.target.value })} /></div>
                <div className="field"><label>Type</label>
                  <select value={payer.tinType} disabled={!payer.create} onChange={(e) => setPayer({ ...payer, tinType: e.target.value as 'SSN' | 'EIN' })}>
                    <option>EIN</option><option>SSN</option>
                  </select></div>
              </div>
              <div className="row">
                <div className="field grow"><label>Address</label>
                  <input value={payer.line1} disabled={!payer.create} onChange={(e) => setPayer({ ...payer, line1: e.target.value })} /></div>
                <div className="field"><label>Line 2</label>
                  <input value={payer.line2} disabled={!payer.create} onChange={(e) => setPayer({ ...payer, line2: e.target.value })} /></div>
                <div className="field"><label>City</label>
                  <input value={payer.city} disabled={!payer.create} onChange={(e) => setPayer({ ...payer, city: e.target.value })} /></div>
                <div className="field" style={{ width: 60 }}><label>State</label>
                  <input value={payer.state} disabled={!payer.create} onChange={(e) => setPayer({ ...payer, state: e.target.value })} /></div>
                <div className="field" style={{ width: 100 }}><label>ZIP</label>
                  <input value={payer.zip} disabled={!payer.create} onChange={(e) => setPayer({ ...payer, zip: e.target.value })} /></div>
              </div>
            </div>
          )}

          <h3 style={{ marginBottom: 4 }}>Recipients</h3>
          <table className="grid">
            <thead>
              <tr><th></th><th>TIN</th><th>Type</th><th>Name</th><th>Name 2</th><th>Address</th><th>City</th><th>ST</th><th>ZIP</th><th>Prior amt</th><th>Status</th></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} style={r.include ? undefined : { opacity: 0.55 }}>
                  <td><input type="checkbox" checked={r.include} onChange={(e) => set(i, { include: e.target.checked })} /></td>
                  <td><input style={{ width: 110 }} value={r.tin} placeholder="required" onChange={(e) => set(i, { tin: e.target.value })} /></td>
                  <td>
                    <select value={r.tinType} onChange={(e) => set(i, { tinType: e.target.value as 'SSN' | 'EIN' })}>
                      <option>SSN</option><option>EIN</option>
                    </select>
                  </td>
                  <td><input style={{ width: 170 }} value={r.name1} onChange={(e) => set(i, { name1: e.target.value })} /></td>
                  <td><input style={{ width: 110 }} value={r.name2} onChange={(e) => set(i, { name2: e.target.value })} /></td>
                  <td>
                    <input style={{ width: 150 }} value={r.line1} onChange={(e) => set(i, { line1: e.target.value })} />
                    <input style={{ width: 90 }} value={r.line2} placeholder="line 2" onChange={(e) => set(i, { line2: e.target.value })} />
                  </td>
                  <td><input style={{ width: 100 }} value={r.city} onChange={(e) => set(i, { city: e.target.value })} /></td>
                  <td><input style={{ width: 36 }} value={r.state} onChange={(e) => set(i, { state: e.target.value })} /></td>
                  <td><input style={{ width: 70 }} value={r.zip} onChange={(e) => set(i, { zip: e.target.value })} /></td>
                  <td className="muted">{r.amount ? `$${r.amount}` : ''}</td>
                  <td>{r.matchName ? <span className="badge warn" title={`matches vault: ${r.matchName}`}>in vault</span> : <span className="badge ok">new</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="row" style={{ marginTop: 10 }}>
            <button
              disabled={busy || blockers.length > 0 || payerBlocked || filedBlocked || (!payer.create && selected.length === 0 && !(importFiled && filedRows.length > 0))}
              onClick={() => void runImport()}
            >
              {payer.create ? 'Create payer + import' : 'Import'} {selected.length} recipient(s){importFiled && filedRows.length > 0 ? ` + ${filedRows.length} filed TY${taxYear} form(s)` : ''}
            </button>
            <button className="secondary" disabled={busy} onClick={() => { setProposal(null); setRows([]); setError(''); }}>Start over</button>
            {blockers.length > 0 && <span className="muted">{blockers.length} selected row(s) missing TIN/name/address.</span>}
            {filedBlocked && <span className="muted">Filed-forms import needs a tax year, form type, amount box, and a payer (created or matched).</span>}
          </div>
        </>
      )}
    </Modal>
  );
}
