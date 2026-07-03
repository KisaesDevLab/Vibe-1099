/**
 * Client entry portal (Phase 5) — magic-link zone, mobile-responsive grid.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, formatCents, parseCentsInput } from '../api';
import { useDialogs } from '../components/Dialogs';

interface Session {
  firmName: string;
  payerName: string;
  taxYear: number;
  formTypes: string[];
  submitted: boolean;
  draftState: { entries?: Entry[] } | null;
  registry: Array<{ formType: string; title: string; boxes: Array<{ id: string; boxNumber: string; label: string; kind: string }> }>;
}
interface Contractor { recipientId: string; name1: string; maskedAddress: string; tinLast4: string; w9Status: string }
interface Entry { recipientId: string; formType: string; boxValues: Record<string, number | boolean | string | null> }

export function ClientPortal() {
  const dialogs = useDialogs();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const opts = useMemo(() => ({ token }), [token]);

  const [session, setSession] = useState<Session | null>(null);
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [formType, setFormType] = useState('');
  const [amounts, setAmounts] = useState<Record<string, string>>({}); // recipientId -> raw amount (primary box)
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [add, setAdd] = useState({ tin: '', tinType: 'SSN' as 'SSN' | 'EIN', name1: '', line1: '', city: '', state: 'MO', zip: '', email: '', mobile: '' });
  const [lookup, setLookup] = useState<{ recipientId: string; maskedName: string; maskedAddress: string } | null>(null);
  const [step, setStep] = useState<'landing' | 'grid' | 'confirm'>('landing');

  useEffect(() => {
    if (!token) { setError('Missing invite token — use the link from your accountant.'); return; }
    api.get<Session>('/api/client-portal/session', opts)
      .then((s) => {
        setSession(s);
        if (s.formTypes[0]) setFormType(s.formTypes[0]);
        const draft = s.draftState?.entries;
        if (draft?.length) {
          const map: Record<string, string> = {};
          for (const e of draft) {
            const primary = e.boxValues['box1'] ?? e.boxValues['box1a'];
            if (typeof primary === 'number') map[e.recipientId] = formatCents(primary);
          }
          setAmounts(map);
        }
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Could not open this link'));
  }, [token, opts]);

  useEffect(() => {
    if (!session || session.submitted) return;
    api.get<{ contractors: Contractor[]; entries: Array<{ recipientId: string; boxValues: Record<string, unknown> }> }>('/api/client-portal/contractors', opts)
      .then((r) => setContractors(r.contractors))
      .catch(() => {});
  }, [session, opts]);

  const primaryBoxId = formType === 'DIV' ? 'box1a' : 'box1';
  const currentReg = session?.registry.find((r) => r.formType === formType);

  const onAddTin = async (value: string) => {
    setAdd((a) => ({ ...a, tin: value }));
    if (value.replace(/\D/g, '').length === 9) {
      const r = await api.post<{ match: { recipientId: string; maskedName: string; maskedAddress: string } | null }>('/api/client-portal/lookup', { tin: value, tinType: add.tinType }, opts).catch(() => null);
      setLookup(r?.match ?? null);
    } else setLookup(null);
  };

  const confirmMatch = () => {
    if (!lookup) return;
    if (!contractors.some((c) => c.recipientId === lookup.recipientId)) {
      setContractors((c) => [...c, { recipientId: lookup.recipientId, name1: lookup.maskedName, maskedAddress: lookup.maskedAddress, tinLast4: '', w9Status: 'on_file' }]);
    }
    setShowAdd(false);
    setLookup(null);
    setAdd({ tin: '', tinType: 'SSN', name1: '', line1: '', city: '', state: 'MO', zip: '', email: '', mobile: '' });
  };

  const addContractor = async () => {
    setError('');
    try {
      const r = await api.post<{ recipientId: string }>('/api/client-portal/contractors', {
        tin: add.tin, tinType: add.tinType, name1: add.name1,
        address: { line1: add.line1, line2: '', city: add.city, state: add.state, zip: add.zip },
        email: add.email || null, mobile: add.mobile || null,
      }, opts);
      setContractors((c) => [...c, { recipientId: r.recipientId, name1: add.name1, maskedAddress: `${add.line1.slice(0, 12)}… ${add.city}`, tinLast4: add.tin.slice(-4), w9Status: 'none' }]);
      setShowAdd(false);
      setAdd({ tin: '', tinType: 'SSN', name1: '', line1: '', city: '', state: 'MO', zip: '', email: '', mobile: '' });
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}${err.details ? ' — ' + JSON.stringify(err.details) : ''}` : String(err));
    }
  };

  const requestW9 = async (name: string) => {
    const email = await dialogs.prompt(`We'll email ${name || 'them'} a secure W-9 form. Their email:`, { title: 'Request a W-9' });
    if (!email) return;
    await api.post('/api/client-portal/w9-request', { name, email }, opts).catch(() => {});
    dialogs.toast('W-9 request sent — your accountant will see the result.', 'success');
  };

  const buildEntries = (): Entry[] =>
    contractors
      .filter((c) => (amounts[c.recipientId] ?? '').trim() !== '')
      .map((c) => ({ recipientId: c.recipientId, formType, boxValues: { [primaryBoxId]: parseCentsInput(amounts[c.recipientId]!) } }));

  const saveDraft = async () => {
    setSaving(true);
    try {
      await api.put('/api/client-portal/draft', { draftState: { entries: buildEntries() } }, opts);
    } finally { setSaving(false); }
  };

  const submit = async () => {
    setError('');
    try {
      const entries = buildEntries();
      if (!entries.length) return setError('Enter at least one amount before submitting.');
      const r = await api.post<{ created: number }>('/api/client-portal/submit', { entries }, opts);
      setDone(true);
      void r;
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}${err.details ? ' — check your amounts' : ''}` : String(err));
    }
  };

  const total = contractors.reduce((n, c) => {
    try { return n + ((amounts[c.recipientId] ?? '').trim() ? parseCentsInput(amounts[c.recipientId]!) : 0); } catch { return n; }
  }, 0);

  if (error && !session) {
    return <div className="portal-shell"><div className="portal-card"><div className="error-box">{error}</div></div></div>;
  }
  if (!session) return <div className="portal-shell"><div className="portal-card">Loading…</div></div>;

  if (session.submitted || done) {
    return (
      <div className="portal-shell">
        <div className="portal-card">
          <div className="portal-brand">{session.firmName}</div>
          <div className="ok-box">
            <strong>Thank you — your {session.taxYear} information for {session.payerName} has been submitted.</strong><br />
            {done && <>You reported {contractors.filter((c) => (amounts[c.recipientId] ?? '').trim()).length} contractor(s), total ${formatCents(total)}.<br /></>}
            Your accountant will review it. If anything needs to change, contact them to re-open this link.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="portal-shell" style={{ maxWidth: 780 }}>
      <div className="portal-card">
        <div className="portal-brand">{session.firmName}</div>
        {error && <div className="error-box">{error}</div>}

        {step === 'landing' && (
          <>
            <h2 style={{ marginTop: 0 }}>{session.taxYear} 1099 information for <strong>{session.payerName}</strong></h2>
            <p>Your accountant needs the amounts you paid your contractors and vendors during {session.taxYear}.</p>
            <ol className="muted">
              <li>Confirm each person/company listed (from last year) and enter the total paid.</li>
              <li>Add anyone new — if you don't have their tax ID, we can request a W-9 for you.</li>
              <li>Submit when done. You can save and come back anytime before submitting.</li>
            </ol>
            {session.formTypes.length > 1 && (
              <div className="field">
                <label>What are you reporting?</label>
                <select value={formType} onChange={(e) => setFormType(e.target.value)}>
                  {session.formTypes.map((t) => (
                    <option key={t} value={t}>1099-{t} — {session.registry.find((r) => r.formType === t)?.title}</option>
                  ))}
                </select>
              </div>
            )}
            <button style={{ width: '100%' }} onClick={() => setStep('grid')}>Start →</button>
          </>
        )}

        {step === 'grid' && (
          <>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>Contractors — 1099-{formType}</h2>
              <span className="muted">step 2 of 3</span>
            </div>
            <table className="grid" style={{ marginTop: 10 }}>
              <thead><tr><th>Who</th><th style={{ width: 140 }} className="num">Total paid {session.taxYear}</th></tr></thead>
              <tbody>
                {contractors.map((c) => (
                  <tr key={c.recipientId}>
                    <td>{c.name1}<div className="muted">{c.maskedAddress}
                      {c.w9Status === 'none' && <> · <a style={{ cursor: 'pointer' }} onClick={() => requestW9(c.name1)}>no W-9 — request one</a></>}
                    </div></td>
                    <td><input className="num" inputMode="decimal" placeholder="0.00" value={amounts[c.recipientId] ?? ''}
                      onChange={(e) => setAmounts((a) => ({ ...a, [c.recipientId]: e.target.value }))} /></td>
                  </tr>
                ))}
                {!contractors.length && <tr><td colSpan={2} className="muted">No contractors yet — add your first below.</td></tr>}
              </tbody>
            </table>

            {!showAdd ? (
              <button className="secondary" style={{ marginTop: 10 }} onClick={() => setShowAdd(true)}>+ Add a contractor</button>
            ) : (
              <div className="panel" style={{ marginTop: 10 }}>
                <div className="row">
                  <div className="field"><label>Tax ID (SSN or EIN)</label><input value={add.tin} onChange={(e) => onAddTin(e.target.value)} /></div>
                  <div className="field"><label>Type</label>
                    <select value={add.tinType} onChange={(e) => setAdd((a) => ({ ...a, tinType: e.target.value as 'SSN' | 'EIN' }))}>
                      <option>SSN</option><option>EIN</option>
                    </select></div>
                </div>
                {lookup && (
                  <div className="warn-box">
                    We have <strong>{lookup.maskedName}</strong> at {lookup.maskedAddress} on file — is this them?
                    <div style={{ marginTop: 6 }}><button className="small" onClick={confirmMatch}>Yes, use them</button></div>
                  </div>
                )}
                <div className="row">
                  <div className="field grow"><label>Name</label><input value={add.name1} onChange={(e) => setAdd((a) => ({ ...a, name1: e.target.value }))} /></div>
                </div>
                <div className="row">
                  <div className="field grow"><label>Street address</label><input value={add.line1} onChange={(e) => setAdd((a) => ({ ...a, line1: e.target.value }))} /></div>
                  <div className="field"><label>City</label><input value={add.city} onChange={(e) => setAdd((a) => ({ ...a, city: e.target.value }))} /></div>
                  <div className="field" style={{ maxWidth: 60 }}><label>State</label><input maxLength={2} value={add.state} onChange={(e) => setAdd((a) => ({ ...a, state: e.target.value }))} /></div>
                  <div className="field" style={{ maxWidth: 100 }}><label>ZIP</label><input value={add.zip} onChange={(e) => setAdd((a) => ({ ...a, zip: e.target.value }))} /></div>
                </div>
                <div className="row">
                  <div className="field grow"><label>Their email (optional)</label><input value={add.email} onChange={(e) => setAdd((a) => ({ ...a, email: e.target.value }))} /></div>
                  <div className="field grow"><label>Their mobile (optional)</label><input value={add.mobile} onChange={(e) => setAdd((a) => ({ ...a, mobile: e.target.value }))} /></div>
                </div>
                <div className="row">
                  <button onClick={addContractor}>Add contractor</button>
                  <button className="secondary" onClick={() => requestW9(add.name1)}>Don't have their TIN? Request a W-9</button>
                  <button className="secondary" onClick={() => setShowAdd(false)}>Cancel</button>
                </div>
              </div>
            )}

            <div className="row" style={{ marginTop: 16, justifyContent: 'space-between' }}>
              <button className="secondary" onClick={saveDraft} disabled={saving}>{saving ? 'Saving…' : 'Save & finish later'}</button>
              <button onClick={() => setStep('confirm')}>Review & submit →</button>
            </div>
          </>
        )}

        {step === 'confirm' && (
          <>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>Review</h2>
              <span className="muted">step 3 of 3</span>
            </div>
            <table className="grid" style={{ marginTop: 10 }}>
              <tbody>
                {contractors.filter((c) => (amounts[c.recipientId] ?? '').trim()).map((c) => (
                  <tr key={c.recipientId}><td>{c.name1}</td><td className="num">${amounts[c.recipientId]}</td></tr>
                ))}
                <tr><td><strong>Total ({contractors.filter((c) => (amounts[c.recipientId] ?? '').trim()).length} contractors)</strong></td>
                  <td className="num"><strong>${formatCents(total)}</strong></td></tr>
              </tbody>
            </table>
            <p className="muted">By submitting you confirm these totals are accurate to the best of your knowledge. {currentReg?.title}.</p>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <button className="secondary" onClick={() => setStep('grid')}>← Back</button>
              <button onClick={submit}>Submit to {session.firmName}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
