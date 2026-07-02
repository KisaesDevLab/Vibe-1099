/**
 * Public W-9 completion (Phase 7): current-revision fields, TIN confirm-entry,
 * ESIGN/UETA consent, typed or drawn signature.
 */
import { FormEvent, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../api';

const CLASSIFICATIONS = [
  ['individual', 'Individual/sole proprietor'],
  ['c_corp', 'C corporation'],
  ['s_corp', 'S corporation'],
  ['partnership', 'Partnership'],
  ['trust_estate', 'Trust/estate'],
  ['llc_c', 'LLC taxed as C corporation'],
  ['llc_s', 'LLC taxed as S corporation'],
  ['llc_p', 'LLC taxed as partnership'],
  ['other', 'Other'],
] as const;

export function W9Portal() {
  const { token = '' } = useParams();
  const [meta, setMeta] = useState<{ firmName: string; requestedName: string } | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [f, setF] = useState({
    name: '', businessName: '', taxClassification: 'individual', otherClassification: '',
    exemptPayeeCode: '', fatcaExemptionCode: '',
    line1: '', line2: '', city: '', state: 'MO', zip: '',
    tin: '', tinConfirm: '', tinType: 'SSN' as 'SSN' | 'EIN',
    signatureName: '', signatureKind: 'typed' as 'typed' | 'drawn', esignConsent: false,
  });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);

  useEffect(() => {
    api.get<{ firmName: string; requestedName: string }>(`/api/w9-public/${encodeURIComponent(token)}`)
      .then((m) => { setMeta(m); if (m.requestedName) setF((x) => ({ ...x, name: m.requestedName })); })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'This W-9 link is not valid'));
  }, [token]);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const startDraw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drawing.current = true;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const { x, y } = pos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  const draw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const { x, y } = pos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  };
  const endDraw = () => { drawing.current = false; };
  const clearSig = () => {
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx && canvasRef.current) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!f.esignConsent) return setError('You must consent to electronic signature.');
    try {
      await api.post(`/api/w9-public/${encodeURIComponent(token)}/submit`, {
        name: f.name,
        businessName: f.businessName,
        taxClassification: f.taxClassification,
        otherClassification: f.otherClassification,
        exemptPayeeCode: f.exemptPayeeCode,
        fatcaExemptionCode: f.fatcaExemptionCode,
        address: { line1: f.line1, line2: f.line2, city: f.city, state: f.state, zip: f.zip },
        tin: f.tin,
        tinConfirm: f.tinConfirm,
        tinType: f.tinType,
        signatureName: f.signatureName || f.name,
        signatureKind: f.signatureKind,
        signatureImage: f.signatureKind === 'drawn' ? canvasRef.current?.toDataURL('image/png') : null,
        esignConsent: true,
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}${err.details ? ' — ' + JSON.stringify(err.details) : ''}` : String(err));
    }
  };

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  if (!meta) {
    return <div className="portal-shell"><div className="portal-card">{error ? <div className="error-box">{error}</div> : 'Loading…'}</div></div>;
  }
  if (done) {
    return (
      <div className="portal-shell">
        <div className="portal-card">
          <div className="portal-brand">{meta.firmName}</div>
          <div className="ok-box"><strong>W-9 submitted.</strong> Thank you — {meta.firmName} has received your information securely.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="portal-shell">
      <div className="portal-card">
        <div className="portal-brand">{meta.firmName} — Form W-9</div>
        <p className="muted">Request for Taxpayer Identification Number and Certification. Your information is transmitted and stored encrypted.</p>
        {error && <div className="error-box">{error}</div>}
        <form onSubmit={submit}>
          <div className="field"><label>1. Name (as shown on your income tax return)</label><input value={f.name} onChange={set('name')} required /></div>
          <div className="field"><label>2. Business name / disregarded entity name (if different)</label><input value={f.businessName} onChange={set('businessName')} /></div>
          <div className="field"><label>3a. Federal tax classification</label>
            <select value={f.taxClassification} onChange={set('taxClassification')}>
              {CLASSIFICATIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></div>
          {f.taxClassification === 'other' && (
            <div className="field"><label>Other classification</label><input value={f.otherClassification} onChange={set('otherClassification')} /></div>
          )}
          <div className="row">
            <div className="field"><label>4. Exempt payee code (if any)</label><input value={f.exemptPayeeCode} onChange={set('exemptPayeeCode')} maxLength={2} /></div>
            <div className="field"><label>FATCA exemption code (if any)</label><input value={f.fatcaExemptionCode} onChange={set('fatcaExemptionCode')} maxLength={3} /></div>
          </div>
          <div className="field"><label>5. Address (number, street, apt)</label><input value={f.line1} onChange={set('line1')} required /></div>
          <div className="row">
            <div className="field grow"><label>6. City</label><input value={f.city} onChange={set('city')} required /></div>
            <div className="field" style={{ maxWidth: 70 }}><label>State</label><input value={f.state} onChange={set('state')} maxLength={2} required /></div>
            <div className="field" style={{ maxWidth: 110 }}><label>ZIP</label><input value={f.zip} onChange={set('zip')} required /></div>
          </div>
          <h2>Part I — Taxpayer Identification Number</h2>
          <div className="row">
            <div className="field"><label>Type</label>
              <select value={f.tinType} onChange={set('tinType')}>
                <option value="SSN">Social Security Number</option>
                <option value="EIN">Employer Identification Number</option>
              </select></div>
            <div className="field grow"><label>{f.tinType}</label><input value={f.tin} onChange={set('tin')} required /></div>
            <div className="field grow"><label>Re-enter to confirm</label><input value={f.tinConfirm} onChange={set('tinConfirm')} required /></div>
          </div>
          <h2>Part II — Certification</h2>
          <div className="muted" style={{ fontSize: 12, border: '1px solid var(--border)', padding: 10, borderRadius: 6 }}>
            Under penalties of perjury, I certify that: <strong>1.</strong> The number shown on this form is my correct taxpayer
            identification number (or I am waiting for a number to be issued to me); and <strong>2.</strong> I am not subject to backup
            withholding because (a) I am exempt from backup withholding, or (b) I have not been notified by the Internal Revenue Service
            (IRS) that I am subject to backup withholding as a result of a failure to report all interest or dividends, or (c) the IRS has
            notified me that I am no longer subject to backup withholding; and <strong>3.</strong> I am a U.S. citizen or other U.S. person;
            and <strong>4.</strong> The FATCA code(s) entered on this form (if any) indicating that I am exempt from FATCA reporting is correct.
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <div className="field"><label>Signature method</label>
              <select value={f.signatureKind} onChange={set('signatureKind')}>
                <option value="typed">Type my name</option>
                <option value="drawn">Draw my signature</option>
              </select></div>
            {f.signatureKind === 'typed' && (
              <div className="field grow"><label>Type your full legal name as your signature</label>
                <input value={f.signatureName} onChange={set('signatureName')} placeholder={f.name} style={{ fontFamily: 'cursive', fontSize: 16 }} /></div>
            )}
          </div>
          {f.signatureKind === 'drawn' && (
            <div className="field">
              <label>Draw your signature</label>
              <canvas
                ref={canvasRef}
                width={480}
                height={120}
                style={{ border: '1px solid var(--border)', borderRadius: 6, touchAction: 'none', width: '100%', background: '#fff' }}
                onPointerDown={startDraw}
                onPointerMove={draw}
                onPointerUp={endDraw}
                onPointerLeave={endDraw}
              />
              <button type="button" className="small secondary" onClick={clearSig}>Clear</button>
            </div>
          )}
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, color: 'var(--text)', margin: '10px 0' }}>
            <input type="checkbox" style={{ width: 'auto', marginTop: 2 }} checked={f.esignConsent}
              onChange={(e) => setF((x) => ({ ...x, esignConsent: e.target.checked }))} />
            <span>I consent to sign this Form W-9 electronically under the ESIGN Act and UETA, and I understand my electronic
              signature is legally binding. My IP address and a timestamp will be recorded.</span>
          </label>
          <button type="submit" style={{ width: '100%' }}>Sign & submit W-9</button>
        </form>
      </div>
    </div>
  );
}
