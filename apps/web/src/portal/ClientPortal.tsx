/**
 * Client entry portal (Phase 5) — magic-link zone, mobile-responsive grid.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, downloadBlob, formatCents, parseCentsInput } from '../api';
import { useDialogs } from '../components/Dialogs';

interface Session {
  firmName: string;
  payerName: string;
  taxYear: number;
  formTypes: string[];
  otpRequired: boolean;
  otpVerified: boolean;
  otpContact: string | null;
  submitted: boolean;
  draftState: { entries?: Entry[] } | null;
  registry: Array<{ formType: string; title: string; boxes: Array<{ id: string; boxNumber: string; label: string; kind: string }> }>;
}
interface Contractor {
  recipientId: string; name1: string; maskedAddress: string; tinLast4: string; w9Status: string;
  /** Form types this contractor is associated with (prior-year + current records). */
  formTypes?: string[];
  name2?: string;
  address?: { line1: string; line2: string; city: string; state: string; zip: string };
  email?: string; mobile?: string; tinType?: 'SSN' | 'EIN';
}
interface Entry { recipientId: string; formType: string; boxValues: Record<string, number | boolean | string | null> }
interface ServerEntry { formId: string; recipientId: string; formType: string; boxValues: Record<string, number | boolean | string | null>; status: string; filed: boolean }

export function ClientPortal() {
  const dialogs = useDialogs();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const opts = useMemo(() => ({ token }), [token]);

  const [session, setSession] = useState<Session | null>(null);
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [entries, setEntries] = useState<ServerEntry[]>([]);
  const [formType, setFormType] = useState('');
  // Amounts + payment-type box are keyed "formType:recipientId": an engagement can
  // cover several form types, and the same vendor may appear on more than one.
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [boxSel, setBoxSel] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [add, setAdd] = useState({ tin: '', tinType: 'SSN' as 'SSN' | 'EIN', name1: '', line1: '', city: '', state: 'MO', zip: '', email: '', mobile: '' });
  const [lookup, setLookup] = useState<{ recipientId: string; maskedName: string; maskedAddress: string } | null>(null);
  const [step, setStep] = useState<'landing' | 'grid' | 'confirm'>('landing');
  const [detail, setDetail] = useState<Contractor | null>(null);
  const [otpVerified, setOtpVerified] = useState(false);
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const otpOk = !session?.otpRequired || session.otpVerified || otpVerified;

  useEffect(() => {
    if (!token) { setError('Missing invite token — use the link from your accountant.'); return; }
    api.get<Session>('/api/client-portal/session', opts)
      .then((s) => {
        setSession(s);
        if (s.formTypes[0]) setFormType(s.formTypes[0]);
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Could not open this link'));
  }, [token, opts]);

  // Always load contractors + entries — even after submit — so the review/thank-you
  // screen can show the full picture of who was reported and how much.
  const sendCode = async () => {
    setError('');
    try {
      const r = await api.post<{ throttled: boolean; sentTo: string }>('/api/client-portal/request-otp', {}, opts);
      setCodeSent(true);
      if (r.throttled) setError('A code was just sent — check your messages (resend in a moment).');
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not send a code'); }
  };
  const verifyCode = async () => {
    setError('');
    try {
      await api.post('/api/client-portal/verify-otp', { code }, opts);
      setOtpVerified(true);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Incorrect code'); }
  };

  useEffect(() => {
    if (!session || !otpOk) return;
    api.get<{ contractors: Contractor[]; entries: ServerEntry[] }>('/api/client-portal/contractors', opts)
      .then((r) => { setContractors(r.contractors); setEntries(r.entries); })
      .catch(() => {});
  }, [session, opts, otpOk]);

  const kf = (ft: string, recipientId: string) => `${ft}:${recipientId}`;
  const primaryFor = (ft: string) => (ft === 'DIV' ? 'box1a' : 'box1');
  const primaryBoxId = primaryFor(formType);
  const currentReg = session?.registry.find((r) => r.formType === formType);
  // Payment-type choices for the current form (e.g. MISC: rents / royalties /
  // other income / …). Withholding is not a payment type a client reports.
  const payBoxes = (currentReg?.boxes ?? []).filter((b) => b.kind === 'cents' && b.id !== 'fedTaxWithheld');

  const filedFor = (ft: string) => new Set(entries.filter((e) => e.formType === ft && e.filed).map((e) => e.recipientId));
  // Recipients whose form for the current type is already filed → amount is locked.
  const filedSet = useMemo(
    () => new Set(entries.filter((e) => e.formType === formType && e.filed).map((e) => e.recipientId)),
    [entries, formType],
  );

  // The grid lists only contractors associated with the current form type (prior-
  // year pairing or a current record) plus any the client added this session.
  const visibleContractors = contractors.filter((c) => !c.formTypes?.length || c.formTypes.includes(formType));

  // Seed amounts + payment-type box from server records (filed + previously-
  // entered), then overlay the unsaved draft for still-editable rows — across ALL
  // form types. Never clobber the client's active typing.
  useEffect(() => {
    const centsBoxOf = (bv: Record<string, unknown>): [string, number] | null => {
      const hit = Object.entries(bv).find(([, v]) => typeof v === 'number');
      return hit ? [hit[0], hit[1] as number] : null;
    };
    const seedAmounts: Record<string, string> = {};
    const seedBoxes: Record<string, string> = {};
    for (const e of entries) {
      const hit = centsBoxOf(e.boxValues);
      if (!hit) continue;
      seedAmounts[kf(e.formType, e.recipientId)] = formatCents(hit[1]);
      seedBoxes[kf(e.formType, e.recipientId)] = hit[0];
    }
    for (const e of session?.draftState?.entries ?? []) {
      if (filedFor(e.formType).has(e.recipientId)) continue;
      const hit = centsBoxOf(e.boxValues);
      if (!hit) continue;
      seedAmounts[kf(e.formType, e.recipientId)] = formatCents(hit[1]);
      seedBoxes[kf(e.formType, e.recipientId)] = hit[0];
    }
    setAmounts((prev) => ({ ...seedAmounts, ...prev }));
    setBoxSel((prev) => ({ ...seedBoxes, ...prev }));
  }, [entries, session]);

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
      setContractors((c) => [...c, { recipientId: lookup.recipientId, formTypes: [formType], name1: lookup.maskedName, maskedAddress: lookup.maskedAddress, tinLast4: '', w9Status: 'on_file' }]);
    } else {
      // already listed under another form type — associate with the current one too
      setContractors((cs) => cs.map((c) => (c.recipientId === lookup.recipientId && c.formTypes?.length && !c.formTypes.includes(formType) ? { ...c, formTypes: [...c.formTypes, formType] } : c)));
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
      setContractors((c) => [...c, { recipientId: r.recipientId, formTypes: [formType], name1: add.name1, maskedAddress: `${add.line1.slice(0, 12)}… ${add.city}`, tinLast4: add.tin.slice(-4), w9Status: 'none' }]);
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

  const printSubstitute = async (ft: string, recipientId: string, name: string) => {
    const entry = entries.find((e) => e.recipientId === recipientId && e.formType === ft && e.filed);
    if (!entry) return;
    try {
      const blob = await api.get<Blob>(`/api/client-portal/forms/${entry.formId}/copy-b`, opts);
      downloadBlob(blob, `1099-${ft}-${name.replace(/[^\w.-]+/g, '_') || 'recipient'}.pdf`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not generate the 1099 PDF');
    }
  };

  // Entries across EVERY form type in the engagement — switching the form-type
  // tab must never drop the other type's amounts from a save or submit.
  const buildEntries = (): Entry[] =>
    (session?.formTypes ?? []).flatMap((ft) => {
      const filed = filedFor(ft);
      return contractors
        .filter((c) => !c.formTypes?.length || c.formTypes.includes(ft))
        .filter((c) => !filed.has(c.recipientId)) // filed forms are locked — never re-submitted
        .filter((c) => (amounts[kf(ft, c.recipientId)] ?? '').trim() !== '')
        .map((c) => ({
          recipientId: c.recipientId,
          formType: ft,
          boxValues: { [boxSel[kf(ft, c.recipientId)] ?? primaryFor(ft)]: parseCentsInput(amounts[kf(ft, c.recipientId)]!) },
        }));
    });

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

  // Every (form type, contractor) pair with an amount — feeds review + thank-you.
  const reportedRows = (session?.formTypes ?? []).flatMap((ft) =>
    contractors
      .filter((c) => !c.formTypes?.length || c.formTypes.includes(ft))
      .filter((c) => (amounts[kf(ft, c.recipientId)] ?? '').trim())
      .map((c) => ({ ft, c })),
  );
  const multiType = (session?.formTypes.length ?? 0) > 1;
  const boxLabel = (ft: string, id: string) => {
    const b = session?.registry.find((r) => r.formType === ft)?.boxes.find((x) => x.id === id);
    return b ? b.label : id;
  };
  const total = reportedRows.reduce((n, { ft, c }) => {
    try { return n + parseCentsInput(amounts[kf(ft, c.recipientId)]!); } catch { return n; }
  }, 0);

  if (error && !session) {
    return <div className="portal-shell"><div className="portal-card"><div className="error-box">{error}</div></div></div>;
  }
  if (!session) return <div className="portal-shell"><div className="portal-card">Loading…</div></div>;

  // OTP gate: a code sent to the client's contact must be verified before viewing.
  if (session.otpRequired && !otpOk) {
    return (
      <div className="portal-shell">
        <div className="portal-card">
          <div className="portal-brand">{session.firmName}</div>
          <p>Before you can enter {session.payerName}'s {session.taxYear} information, verify it's you.</p>
          <p className="muted">We'll send a one-time code to {session.otpContact ?? 'your contact on file'}.</p>
          {error && <div className="error-box">{error}</div>}
          <button className="secondary" style={{ width: '100%', marginBottom: 8 }} onClick={sendCode}>{codeSent ? 'Resend code' : 'Send code'}</button>
          {codeSent && (
            <>
              <div className="field">
                <label>6-digit code</label>
                <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" maxLength={6} autoFocus />
              </div>
              <button style={{ width: '100%' }} disabled={code.length !== 6} onClick={verifyCode}>Verify</button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (session.submitted || done) {
    return (
      <div className="portal-shell" style={{ maxWidth: 780 }}>
        <div className="portal-card">
          <div className="portal-brand">{session.firmName}</div>
          <div className="ok-box">
            <strong>Thank you — your {session.taxYear} information for {session.payerName} has been submitted.</strong><br />
            You reported {reportedRows.length} payment(s), total ${formatCents(total)}.<br />
            Your accountant will review it. If anything needs to change, contact them to re-open this link.
          </div>
          {reportedRows.length > 0 && (
            <>
              <h3>What you reported</h3>
              <table className="grid">
                <thead><tr><th>Who</th>{multiType && <th>Form</th>}<th className="num">Total paid {session.taxYear}</th><th></th></tr></thead>
                <tbody>
                  {reportedRows.map(({ ft, c }) => {
                    const filed = filedFor(ft).has(c.recipientId);
                    return (
                      <tr key={kf(ft, c.recipientId)}>
                        <td>{c.name1}</td>
                        {multiType && <td className="muted">1099-{ft}</td>}
                        <td className="num">${amounts[kf(ft, c.recipientId)]}{filed && <span className="badge ok" style={{ marginLeft: 6 }}>filed</span>}</td>
                        <td>{filed && <a style={{ cursor: 'pointer' }} onClick={() => printSubstitute(ft, c.recipientId, c.name1)}>Print 1099</a>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="muted">Filed 1099s can be printed for your records. Tax ID numbers are truncated for privacy.</p>
            </>
          )}
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
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <button className="secondary small" onClick={() => setStep('landing')}>← Back</button>
              <span className="muted">step 2 of 3</span>
            </div>
            <h2 style={{ margin: '8px 0 0' }}>{session.payerName}</h2>
            <div className="muted" style={{ marginBottom: 10 }}>{session.taxYear} 1099-{formType} — contractors &amp; amounts paid</div>
            {multiType && (
              <div className="row" style={{ gap: 6, marginBottom: 4 }}>
                {session.formTypes.map((t) => (
                  <button key={t} className={t === formType ? 'small' : 'secondary small'} onClick={() => setFormType(t)}>
                    1099-{t}
                  </button>
                ))}
                <span className="muted" style={{ alignSelf: 'center' }}>each form keeps its own list — switch freely, nothing is lost</span>
              </div>
            )}
            <table className="grid" style={{ marginTop: 10 }}>
              <thead><tr><th>Who</th>{payBoxes.length > 1 && <th style={{ width: 190 }}>Type of payment</th>}<th style={{ width: 140 }} className="num">Total paid {session.taxYear}</th></tr></thead>
              <tbody>
                {visibleContractors.map((c) => {
                  const filed = filedSet.has(c.recipientId);
                  const key = kf(formType, c.recipientId);
                  return (
                    <tr key={c.recipientId}>
                      <td>
                        <a style={{ cursor: 'pointer', fontWeight: 600 }} onClick={() => setDetail(c)} title="View name & mailing info">{c.name1}</a>
                        <div className="muted">{c.maskedAddress}
                          {c.w9Status === 'none' && !filed && <> · <a style={{ cursor: 'pointer' }} onClick={() => requestW9(c.name1)}>no W-9 — request one</a></>}
                        </div>
                      </td>
                      {payBoxes.length > 1 && (
                        <td>
                          {filed ? (
                            <span className="muted">{boxLabel(formType, boxSel[key] ?? primaryBoxId)}</span>
                          ) : (
                            <select value={boxSel[key] ?? primaryBoxId} onChange={(e) => setBoxSel((b) => ({ ...b, [key]: e.target.value }))}>
                              {payBoxes.map((b) => (<option key={b.id} value={b.id}>{b.label}</option>))}
                            </select>
                          )}
                        </td>
                      )}
                      <td>
                        {filed ? (
                          <div className="num" style={{ whiteSpace: 'nowrap' }}>
                            ${amounts[key] ?? '0.00'} <span className="badge ok" title="Already filed with the IRS — locked">filed</span>
                            <div><a style={{ cursor: 'pointer', fontSize: 12 }} onClick={() => printSubstitute(formType, c.recipientId, c.name1)}>Print 1099</a></div>
                          </div>
                        ) : (
                          <input className="num" inputMode="decimal" placeholder="0.00" value={amounts[key] ?? ''}
                            onChange={(e) => setAmounts((a) => ({ ...a, [key]: e.target.value }))} />
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!visibleContractors.length && <tr><td colSpan={payBoxes.length > 1 ? 3 : 2} className="muted">No contractors on this form yet — add your first below.</td></tr>}
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
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <button className="secondary small" onClick={() => setStep('grid')}>← Back</button>
              <span className="muted">step 3 of 3</span>
            </div>
            <h2 style={{ margin: '8px 0 0' }}>Review — {session.payerName}</h2>
            <div className="muted" style={{ marginBottom: 10 }}>{session.taxYear}{multiType ? ' — all forms' : ` 1099-${formType}`}</div>
            <table className="grid" style={{ marginTop: 10 }}>
              <tbody>
                {reportedRows.map(({ ft, c }) => (
                  <tr key={kf(ft, c.recipientId)}>
                    <td><a style={{ cursor: 'pointer' }} onClick={() => setDetail(c)}>{c.name1}</a></td>
                    <td className="muted">{multiType && `1099-${ft} · `}{boxLabel(ft, boxSel[kf(ft, c.recipientId)] ?? primaryFor(ft))}</td>
                    <td className="num">${amounts[kf(ft, c.recipientId)]}</td>
                  </tr>
                ))}
                <tr><td colSpan={2}><strong>Total ({reportedRows.length} payment(s))</strong></td>
                  <td className="num"><strong>${formatCents(total)}</strong></td></tr>
              </tbody>
            </table>
            <p className="muted">By submitting you confirm these totals are accurate to the best of your knowledge.</p>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <button className="secondary" onClick={() => setStep('grid')}>← Back</button>
              <button onClick={submit}>Submit to {session.firmName}</button>
            </div>
          </>
        )}
      </div>

      {detail && (
        <div
          onClick={() => setDetail(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 50 }}
        >
          <div className="portal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420, width: '100%' }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <h2 style={{ margin: 0 }}>{detail.name1}</h2>
              <span onClick={() => setDetail(null)} style={{ cursor: 'pointer', fontWeight: 700, fontSize: 18, lineHeight: 1 }} title="Close">×</span>
            </div>
            {detail.name2 && <div className="muted">{detail.name2}</div>}
            <h3 style={{ marginBottom: 4 }}>Mailing address</h3>
            {detail.address ? (
              <div>
                {detail.address.line1}<br />
                {detail.address.line2 && <>{detail.address.line2}<br /></>}
                {detail.address.city}, {detail.address.state} {detail.address.zip}
              </div>
            ) : <div className="muted">{detail.maskedAddress}</div>}
            <h3 style={{ marginBottom: 4 }}>Details</h3>
            <div className="muted">
              Tax ID: {detail.tinLast4 ? (detail.tinType === 'SSN' ? `XXX-XX-${detail.tinLast4}` : `XX-XXX${detail.tinLast4}`) : '—'}<br />
              {detail.email && <>Email: {detail.email}<br /></>}
              {detail.mobile && <>Mobile: {detail.mobile}<br /></>}
              W-9: {detail.w9Status}
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>Copy B is mailed to this address. To correct it, contact your accountant.</p>
          </div>
        </div>
      )}
    </div>
  );
}
