import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, ApiError, downloadBlob } from '../api';
import { useDialogs } from '../components/Dialogs';
import { Modal } from '../components/Modal';
import { refreshTaxYears } from '../components/useTaxYears';
import type { Me } from './Shell';

interface Firm {
  id: string; name: string; ein: string; address: Record<string, string>; phone: string;
  irisEnvironment: string; moWithholdingId: string;
  impositionOffsetX16: number; impositionOffsetY16: number; licenseTier: string;
}
interface IrisSettings {
  tcc: string; apiClientId: string; hasJwk: boolean; publicJwk: Record<string, unknown> | null; environment: 'ATS' | 'PROD';
  filingProvider: 'iris' | 'tax1099';
  tax1099Environment: 'sandbox' | 'production';
  tax1099Mailing: boolean;
  hasTax1099Key: boolean;
  tax1099ApiKey?: string; // transient input only
  tax1099DisclosureAckAt: string | null;
  acknowledgeTax1099Disclosure?: boolean; // transient input only
}
interface User { id: string; email: string; name: string; role: string; active: boolean; totpEnabled: boolean; lastLoginAt: string | null }
interface AuditEntry { id: number; createdAt: string; actorType: string; actorId: string | null; action: string; entityType: string; entityId: string | null; ip: string | null }

export function Settings() {
  const me = useOutletContext<Me>();
  const dialogs = useDialogs();
  const [tab, setTab] = useState<'firm' | 'efile' | 'delivery' | 'users' | 'advanced'>('firm');
  const [firm, setFirm] = useState<Firm | null>(null);
  const [iris, setIris] = useState<IrisSettings | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [queues, setQueues] = useState<Record<string, Record<string, number>>>({});
  const [license, setLicense] = useState<Record<string, unknown> | null>(null);
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [newUser, setNewUser] = useState({ email: '', name: '', role: 'preparer', password: '' });
  const [totpSetup, setTotpSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [sms, setSms] = useState({ provider: 'env', textlinkApiKey: '', twilioAccountSid: '', twilioAuthToken: '', twilioFromNumber: '', hasTextlinkKey: false, hasTwilioAuth: false, envProvider: 'none' });
  const [email, setEmail] = useState({ provider: 'env', from: '', replyTo: '', emailitApiKey: '', host: '', port: '587', user: '', pass: '', secure: false, hasEmailitKey: false, hasSmtpPass: false, envProvider: 'auto' });
  const [editUser, setEditUser] = useState<User | null>(null);
  const [filingYears, setFilingYears] = useState<{ years: number[]; current: number }>({ years: [], current: 0 });
  const [thresholds, setThresholds] = useState<Record<string, string>>({});
  const isAdmin = me.role === 'admin';

  const loadAll = () => {
    api.get<{ firm: Firm }>('/api/admin/firm').then((r) => setFirm(r.firm)).catch(() => {});
    api.get<{ settings: Record<string, unknown> }>('/api/admin/settings').then((r) => {
      setSettings(r.settings);
      const t = (r.settings['federal_thresholds'] as Record<string, number>) ?? {};
      setThresholds(Object.fromEntries(Object.entries(t).map(([k, v]) => [k, (v / 100).toString()])));
    }).catch(() => {});
    if (me.role === 'admin') {
      api.get<typeof sms>('/api/admin/sms').then((r) => setSms((s) => ({ ...s, ...r }))).catch(() => {});
      api.get<typeof email>('/api/admin/email').then((r) => setEmail((s) => ({ ...s, ...r }))).catch(() => {});
    }
    api.get<{ years: number[]; current: number }>('/api/admin/tax-years').then(setFilingYears).catch(() => {});
    if (isAdmin) {
      api.get<IrisSettings>('/api/iris/settings').then(setIris).catch(() => {});
      api.get<{ users: User[] }>('/api/auth/users').then((r) => setUsers(r.users)).catch(() => {});
      api.get<Record<string, unknown>>('/api/admin/license').then(setLicense).catch(() => {});
    }
    api.get<{ queues: Record<string, Record<string, number>> }>('/api/admin/queues').then((r) => setQueues(r.queues)).catch(() => {});
    // /api/status returns 503 when a dependency is down — read the body regardless
    // so the panel shows the degraded detail exactly when it's most useful
    fetch('/api/status', { credentials: 'same-origin' }).then((r) => r.json()).then(setStatus).catch(() => {});
  };
  useEffect(loadAll, [isAdmin]);

  const saveFirm = async () => {
    if (!firm) return;
    try {
      await api.put('/api/admin/firm', {
        name: firm.name, ein: firm.ein, address: firm.address, phone: firm.phone,
        moWithholdingId: firm.moWithholdingId,
        impositionOffsetX16: firm.impositionOffsetX16, impositionOffsetY16: firm.impositionOffsetY16,
      });
      setNotice('Firm settings saved.');
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
  };

  const saveIris = async () => {
    if (!iris) return;
    try {
      await api.put('/api/iris/settings', {
        tcc: iris.tcc, apiClientId: iris.apiClientId, environment: iris.environment,
        filingProvider: iris.filingProvider,
        tax1099Environment: iris.tax1099Environment,
        tax1099Mailing: iris.tax1099Mailing,
        ...(iris.tax1099ApiKey ? { tax1099ApiKey: iris.tax1099ApiKey } : {}),
        ...(iris.acknowledgeTax1099Disclosure ? { acknowledgeTax1099Disclosure: true } : {}),
      });
      setIris((i) => (i ? { ...i, tax1099ApiKey: '', acknowledgeTax1099Disclosure: false, hasTax1099Key: i.hasTax1099Key || !!i.tax1099ApiKey, tax1099DisclosureAckAt: i.tax1099DisclosureAckAt ?? (i.acknowledgeTax1099Disclosure ? new Date().toISOString() : null) } : i));
      setNotice('E-file settings saved.');
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
  };

  const generateJwk = async () => {
    const r = await api.post<{ publicJwk: Record<string, unknown> }>('/api/iris/settings/generate-jwk');
    setNotice('JWK generated. Register the public key below with IRS A2A enrollment.');
    setIris((i) => (i ? { ...i, hasJwk: true, publicJwk: r.publicJwk } : i));
  };

  const addUser = async () => {
    try {
      await api.post('/api/auth/users', newUser);
      setNewUser({ email: '', name: '', role: 'preparer', password: '' });
      setNotice('User created.');
      loadAll();
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
  };

  const toggleUser = async (u: User) => {
    await api.patch(`/api/auth/users/${u.id}`, { active: !u.active });
    loadAll();
  };

  const saveUser = async () => {
    if (!editUser) return;
    try {
      await api.patch(`/api/auth/users/${editUser.id}`, { name: editUser.name, email: editUser.email, role: editUser.role });
      setEditUser(null);
      dialogs.toast('User updated.', 'success');
      loadAll();
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
  };

  const resetPassword = async (u: User) => {
    const pw = await dialogs.prompt(`Set a new password for ${u.name} (12+ chars). They must sign in again.`, { title: 'Reset password' });
    if (!pw) return;
    try {
      await api.post(`/api/auth/users/${u.id}/reset-password`, { password: pw });
      dialogs.toast(`Password reset for ${u.name}.`, 'success');
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
  };

  const saveEmail = async () => {
    try {
      await api.put('/api/admin/email', {
        provider: email.provider,
        from: email.from, replyTo: email.replyTo,
        ...(email.emailitApiKey ? { emailitApiKey: email.emailitApiKey } : {}),
        ...(email.host ? { host: email.host } : {}),
        port: Number(email.port) || 587,
        ...(email.user ? { user: email.user } : {}),
        ...(email.pass ? { pass: email.pass } : {}),
        secure: email.secure,
      });
      dialogs.toast('Email settings saved (credentials stored encrypted).', 'success');
      setEmail((s) => ({ ...s, emailitApiKey: '', pass: '' }));
      loadAll();
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
  };

  const rolloverYear = async () => {
    const next = (filingYears.current || new Date().getFullYear()) + 1;
    if (!(await dialogs.confirm(`Create filing year ${next} and make it the default? Existing years stay available.`, { title: 'Roll over filing year' }))) return;
    try {
      const r = await api.post<{ years: number[]; current: number }>('/api/admin/tax-years/rollover', {});
      setFilingYears(r);
      refreshTaxYears();
      dialogs.toast(`Filing year ${r.current} is now active.`, 'success');
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
  };

  const setCurrentYear = async (taxYear: number) => {
    try {
      const r = await api.put<{ years: number[]; current: number }>('/api/admin/tax-years/current', { taxYear });
      setFilingYears(r);
      refreshTaxYears();
      dialogs.toast(`Default filing year set to ${taxYear}.`, 'success');
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
  };

  const loadAudit = async () => {
    const r = await api.get<{ entries: AuditEntry[] }>('/api/admin/audit');
    setAudit(r.entries);
  };

  const exportAudit = async () => {
    const blob = await api.get<Blob>('/api/admin/audit?format=csv');
    downloadBlob(blob, 'audit-log.csv');
  };

  const startTotp = async () => {
    const password = await dialogs.prompt('Confirm your account password to set up 2FA:', { title: 'Confirm password', password: true });
    if (!password) return;
    try {
      const r = await api.post<{ secret: string; otpauthUrl: string }>('/api/auth/totp/setup', { password });
      setTotpSetup(r);
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
  };
  const confirmTotp = async () => {
    try {
      await api.post('/api/auth/totp/confirm', { code: totpCode });
      setNotice('TOTP enabled.');
      setTotpSetup(null);
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
  };

  const saveSetting = async (key: string, value: unknown) => {
    await api.put(`/api/admin/settings/${key}`, { value });
    dialogs.toast('Setting saved.', 'success');
    loadAll();
  };

  const yearLock = async (lock: boolean) => {
    const year = await dialogs.prompt('Tax year to ' + (lock ? 'lock' : 'unlock') + ':', { title: lock ? 'Lock tax year' : 'Unlock tax year', defaultValue: '2026' });
    if (!year) return;
    if (lock) await api.post(`/api/dashboard/year-lock/${year}`);
    else await api.del(`/api/dashboard/year-lock/${year}`);
    dialogs.toast(`Tax year ${year} ${lock ? 'locked' : 'unlocked'}.`, 'success');
  };

  const calibration = async () => {
    const blob = await api.get<Blob>('/api/batches/test-pattern');
    downloadBlob(blob, 'calibration.pdf');
  };

  return (
    <div>
      <h1>Settings</h1>
      {error && <div className="error-box" onClick={() => setError('')}>{error}</div>}
      {notice && <div className="ok-box" onClick={() => setNotice('')}>{notice}</div>}

      <div className="tabs">
        {([
          ['firm', 'Firm & printing'],
          ['efile', 'IRS e-file'],
          ['delivery', 'Delivery & SMS'],
          ['users', 'Users'],
          ['advanced', 'Advanced'],
        ] as const).map(([t, label]) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => { setTab(t); if (t === 'advanced') void loadAudit(); }}>{label}</button>
        ))}
      </div>

      {tab === 'firm' && firm && (
        <div className="panel">
          <div className="row">
            <div className="field grow"><label>Firm name</label><input disabled={!isAdmin} value={firm.name} onChange={(e) => setFirm({ ...firm, name: e.target.value })} /></div>
            <div className="field"><label>EIN</label><input disabled={!isAdmin} value={firm.ein} onChange={(e) => setFirm({ ...firm, ein: e.target.value })} /></div>
            <div className="field"><label>Phone</label><input disabled={!isAdmin} value={firm.phone} onChange={(e) => setFirm({ ...firm, phone: e.target.value })} /></div>
            <div className="field"><label>MO withholding ID (firm)</label><input disabled={!isAdmin} value={firm.moWithholdingId} onChange={(e) => setFirm({ ...firm, moWithholdingId: e.target.value })} /></div>
          </div>
          <h2>Pressure-seal calibration (±1/16″ steps)</h2>
          <div className="row">
            <div className="field"><label>Offset X (16ths of an inch)</label>
              <input type="number" min={-16} max={16} disabled={!isAdmin} value={firm.impositionOffsetX16}
                onChange={(e) => setFirm({ ...firm, impositionOffsetX16: Number(e.target.value) })} /></div>
            <div className="field"><label>Offset Y (16ths of an inch)</label>
              <input type="number" min={-16} max={16} disabled={!isAdmin} value={firm.impositionOffsetY16}
                onChange={(e) => setFirm({ ...firm, impositionOffsetY16: Number(e.target.value) })} /></div>
            <button className="secondary" onClick={calibration}>Print calibration sheet</button>
          </div>
          <h2>Reviewer gate</h2>
          <div className="row">
            <div className="field"><label>Require reviewer approval before queue/transmit</label>
              <select disabled={!isAdmin} value={settings['reviewer_gate_enabled'] ? '1' : '0'} onChange={(e) => saveSetting('reviewer_gate_enabled', e.target.value === '1')}>
                <option value="0">Off</option><option value="1">On</option>
              </select></div>
            {isAdmin && (
              <>
                <button className="secondary" onClick={() => yearLock(true)}>Lock a tax year</button>
                <button className="secondary" onClick={() => yearLock(false)}>Unlock a tax year</button>
              </>
            )}
          </div>
          <h2>My account</h2>
          {!totpSetup ? (
            <button className="secondary" onClick={startTotp}>Set up TOTP two-factor</button>
          ) : (
            <div>
              <p>Add this secret to your authenticator app: <span className="mono">{totpSetup.secret}</span></p>
              <div className="row">
                <div className="field"><label>6-digit code</label><input value={totpCode} onChange={(e) => setTotpCode(e.target.value)} maxLength={6} /></div>
                <button onClick={confirmTotp}>Confirm & enable</button>
              </div>
            </div>
          )}
          {isAdmin && <div style={{ marginTop: 16 }}><button onClick={saveFirm}>Save firm settings</button></div>}
        </div>
      )}

      {tab === 'efile' && isAdmin && iris && (
        <div className="panel">
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div className="field"><label>Filing backend</label>
              <select value={iris.filingProvider} onChange={(e) => setIris({ ...iris, filingProvider: e.target.value as 'iris' | 'tax1099' })}>
                <option value="iris">IRIS A2A — we are the Transmitter (needs our TCC)</option>
                <option value="tax1099">Tax1099 (Zenwork) — files on our behalf (no TCC)</option>
              </select></div>
            <button onClick={saveIris}>Save</button>
          </div>
          <p className="muted">Default backend for all payers; individual payers can override it on their record. IRIS uses this firm's TCC/JWK below. Tax1099 files through Zenwork so no IRS TCC is needed.</p>

          {iris.filingProvider === 'tax1099' && (
            <div className="panel" style={{ background: '#fff7ed', borderColor: '#fed7aa' }}>
              <h2 style={{ marginTop: 0 }}>Tax1099 (Zenwork)</h2>
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <div className="field grow"><label>API key {iris.hasTax1099Key && <span className="muted">(saved — leave blank to keep)</span>}</label>
                  <input type="password" placeholder={iris.hasTax1099Key ? '••••••••' : 'Tax1099 app key'} value={iris.tax1099ApiKey ?? ''}
                    onChange={(e) => setIris({ ...iris, tax1099ApiKey: e.target.value })} /></div>
                <div className="field"><label>Environment</label>
                  <select value={iris.tax1099Environment} onChange={(e) => setIris({ ...iris, tax1099Environment: e.target.value as 'sandbox' | 'production' })}>
                    <option value="sandbox">Sandbox (test)</option><option value="production">Production</option>
                  </select></div>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={iris.tax1099Mailing}
                    onChange={(e) => setIris({ ...iris, tax1099Mailing: e.target.checked })} /> Let Tax1099 USPS-mail recipient copies
                </label>
                <button onClick={saveIris}>Save</button>
              </div>
              {iris.tax1099Environment === 'sandbox' && <div className="warn-box">Sandbox — submissions are TEST filings, not sent to the IRS.</div>}
              {iris.tax1099DisclosureAckAt ? (
                <p className="muted" style={{ marginBottom: 0 }}>§7216 disclosure acknowledged on {new Date(iris.tax1099DisclosureAckAt).toLocaleDateString()}. Recipient TINs, addresses, and amounts are transmitted to Zenwork (Tax1099) to file/mail on the payer's behalf.</p>
              ) : (
                <div className="warn-box">
                  <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <input type="checkbox" style={{ width: 'auto', marginTop: 3 }} checked={!!iris.acknowledgeTax1099Disclosure}
                      onChange={(e) => setIris({ ...iris, acknowledgeTax1099Disclosure: e.target.checked })} />
                    <span>I acknowledge that filing/mailing through Tax1099 discloses recipient TINs (SSNs/EINs), names, addresses, and dollar amounts to Zenwork, Inc. as an auxiliary service provider under Treas. Reg. §301.7216-2(d). Filing stays disabled until this is accepted.</span>
                  </label>
                </div>
              )}
            </div>
          )}

          <h2>IRIS A2A (self-file)</h2>
          <div className="row">
            <div className="field"><label>TCC (Transmitter Control Code)</label><input value={iris.tcc} onChange={(e) => setIris({ ...iris, tcc: e.target.value })} /></div>
            <div className="field grow"><label>API Client ID</label><input value={iris.apiClientId} onChange={(e) => setIris({ ...iris, apiClientId: e.target.value })} /></div>
            <div className="field"><label>Environment</label>
              <select value={iris.environment} onChange={(e) => setIris({ ...iris, environment: e.target.value as 'ATS' | 'PROD' })}>
                <option value="ATS">ATS (test)</option><option value="PROD">Production</option>
              </select></div>
            <button onClick={saveIris}>Save</button>
          </div>
          {iris.environment === 'ATS' && <div className="warn-box">ATS mode — transmissions are TEST filings. Pass ATS scenarios, then the IRS flips your TCC to Production.</div>}
          <h2>Signing key (JWK)</h2>
          <p className="muted">The private key is envelope-encrypted at rest. Register the PUBLIC JWK with IRS A2A enrollment. Rotation: generate a new pair, re-register, keep transmitting.</p>
          <div className="row">
            <button className="secondary" onClick={generateJwk}>{iris.hasJwk ? 'Rotate keypair' : 'Generate keypair'}</button>
          </div>
          {iris.publicJwk && (
            <pre className="mono" style={{ background: '#f1f5f9', padding: 10, overflow: 'auto', fontSize: 11 }}>{JSON.stringify(iris.publicJwk, null, 2)}</pre>
          )}
          <h2>Onboarding checklist</h2>
          <ol className="muted">
            <li>Apply for IRIS A2A TCC (Transmitter role) — ID.me-verified Responsible Officials; allow 45+ days</li>
            <li>Apply for the API Client ID after TCC approval</li>
            <li>Generate the JWK here → register the public key with the IRS</li>
            <li>Pass ATS communication/scenario testing in ATS mode</li>
            <li>IRS flips the TCC to Production → switch the environment above</li>
          </ol>
          <h2>Federal filing thresholds (warn-only, per form type & year)</h2>
          <p className="muted">Amounts below the threshold warn but never block (LOCKED decision). Blank = registry default (TY2026+ NEC/MISC: $2,000 per OBBBA; earlier years: $600). Rows follow your enabled filing years.</p>
          <table className="grid" style={{ maxWidth: 460 }}>
            <thead><tr><th>Tax year</th><th className="num">1099-NEC ($)</th><th className="num">1099-MISC ($)</th></tr></thead>
            <tbody>
              {filingYears.years.map((y) => (
                <tr key={y}>
                  <td>{y}{y === filingYears.current && <span className="badge ok" style={{ marginLeft: 6 }}>current</span>}</td>
                  {['NEC', 'MISC'].map((ft) => {
                    const key = `${ft}:${y}`;
                    return (
                      <td key={key}>
                        <input className="num" value={thresholds[key] ?? ''} placeholder="default"
                          onChange={(e) => setThresholds((t) => ({ ...t, [key]: e.target.value }))} />
                      </td>
                    );
                  })}
                </tr>
              ))}
              {!filingYears.years.length && <tr><td colSpan={3} className="muted">Loading enabled years…</td></tr>}
            </tbody>
          </table>
          <button className="secondary" style={{ marginTop: 8 }} onClick={() => {
            const map: Record<string, number> = {};
            for (const [k, v] of Object.entries(thresholds)) if (v.trim() !== '') map[k] = Math.round(parseFloat(v) * 100);
            void saveSetting('federal_thresholds', map);
          }}>Save thresholds</button>
        </div>
      )}

      {tab === 'delivery' && isAdmin && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Email provider <span className="muted" style={{ fontWeight: 400 }}>(firm-level; overrides appliance env: {email.envProvider})</span></h2>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div className="field"><label>Provider</label>
              <select value={email.provider} onChange={(e) => setEmail((s) => ({ ...s, provider: e.target.value }))}>
                <option value="env">Use appliance env config</option>
                <option value="emailit">EmailIt.com (API)</option>
                <option value="smtp">SMTP relay</option>
                <option value="none">Disabled</option>
              </select></div>
            {email.provider !== 'env' && email.provider !== 'none' && (
              <>
                <div className="field grow"><label>From address</label>
                  <input placeholder="1099s@yourfirm.com" value={email.from} onChange={(e) => setEmail((s) => ({ ...s, from: e.target.value }))} /></div>
                <div className="field grow"><label>Reply-to (optional)</label>
                  <input value={email.replyTo} onChange={(e) => setEmail((s) => ({ ...s, replyTo: e.target.value }))} /></div>
              </>
            )}
          </div>
          {email.provider === 'emailit' && (
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <div className="field grow"><label>EmailIt API key {email.hasEmailitKey && <span className="muted">(saved — blank keeps current)</span>}</label>
                <input type="password" placeholder={email.hasEmailitKey ? '••••••••' : 'EmailIt API key (v2)'} value={email.emailitApiKey} onChange={(e) => setEmail((s) => ({ ...s, emailitApiKey: e.target.value }))} /></div>
            </div>
          )}
          {email.provider === 'smtp' && (
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <div className="field grow"><label>Host</label><input value={email.host} onChange={(e) => setEmail((s) => ({ ...s, host: e.target.value }))} /></div>
              <div className="field" style={{ maxWidth: 90 }}><label>Port</label><input value={email.port} onChange={(e) => setEmail((s) => ({ ...s, port: e.target.value }))} /></div>
              <div className="field"><label>Username</label><input value={email.user} onChange={(e) => setEmail((s) => ({ ...s, user: e.target.value }))} /></div>
              <div className="field"><label>Password {email.hasSmtpPass && <span className="muted">(saved)</span>}</label>
                <input type="password" value={email.pass} onChange={(e) => setEmail((s) => ({ ...s, pass: e.target.value }))} /></div>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={email.secure} onChange={(e) => setEmail((s) => ({ ...s, secure: e.target.checked }))} /> TLS
              </label>
            </div>
          )}
          <button className="secondary" onClick={saveEmail}>Save email settings</button>

          <h2 style={{ marginTop: 20 }}>SMS provider <span className="muted" style={{ fontWeight: 400 }}>(firm-level; overrides appliance env: {sms.envProvider})</span></h2>
          <div className="row">
            <div className="field"><label>Provider</label>
              <select value={sms.provider} onChange={(e) => setSms((s) => ({ ...s, provider: e.target.value }))}>
                <option value="env">Use appliance env config</option>
                <option value="textlink">TextLink</option>
                <option value="twilio">Twilio</option>
                <option value="none">Disabled</option>
              </select></div>
            {sms.provider === 'textlink' && (
              <div className="field grow"><label>TextLink API key {sms.hasTextlinkKey && '(saved — blank keeps current)'}</label>
                <input type="password" value={sms.textlinkApiKey} onChange={(e) => setSms((s) => ({ ...s, textlinkApiKey: e.target.value }))} /></div>
            )}
            {sms.provider === 'twilio' && (
              <>
                <div className="field"><label>Account SID</label>
                  <input value={sms.twilioAccountSid} onChange={(e) => setSms((s) => ({ ...s, twilioAccountSid: e.target.value }))} /></div>
                <div className="field"><label>Auth token {sms.hasTwilioAuth && '(saved)'}</label>
                  <input type="password" value={sms.twilioAuthToken} onChange={(e) => setSms((s) => ({ ...s, twilioAuthToken: e.target.value }))} /></div>
                <div className="field"><label>From number</label>
                  <input value={sms.twilioFromNumber} onChange={(e) => setSms((s) => ({ ...s, twilioFromNumber: e.target.value }))} /></div>
              </>
            )}
            <button className="secondary" onClick={async () => {
              try {
                await api.put('/api/admin/sms', {
                  provider: sms.provider,
                  ...(sms.textlinkApiKey ? { textlinkApiKey: sms.textlinkApiKey } : {}),
                  ...(sms.twilioAccountSid ? { twilioAccountSid: sms.twilioAccountSid } : {}),
                  ...(sms.twilioAuthToken ? { twilioAuthToken: sms.twilioAuthToken } : {}),
                  ...(sms.twilioFromNumber ? { twilioFromNumber: sms.twilioFromNumber } : {}),
                });
                dialogs.toast('SMS settings saved (credentials stored encrypted).', 'success');
                setSms((s) => ({ ...s, textlinkApiKey: '', twilioAuthToken: '' }));
                loadAll();
              } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
            }}>Save SMS settings</button>
          </div>
          <h2>Message templates</h2>
          <p className="muted">Placeholders use {'{{var}}'}. Links always carry opaque tokens — never a TIN or a name. Edit as JSON:</p>
          <TemplateEditor disabled={!isAdmin} value={settings['message_templates']} onSave={(v) => saveSetting('message_templates', v)} />
        </div>
      )}

      {tab === 'users' && isAdmin && (
        <div className="panel">
          <table className="grid">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>TOTP</th><th>Last login</th><th></th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} style={{ opacity: u.active ? 1 : 0.5 }}>
                  <td>{u.name}</td><td>{u.email}</td><td>{u.role}</td>
                  <td>{u.totpEnabled ? '✓' : '—'}</td>
                  <td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="small secondary" onClick={() => setEditUser(u)}>Edit</button>
                    <button className="small secondary" onClick={() => resetPassword(u)}>Reset password</button>
                    <button className={`small ${u.active ? 'danger' : ''}`} onClick={() => toggleUser(u)}>{u.active ? 'Deactivate' : 'Activate'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {editUser && (
            <Modal title={`Edit ${editUser.name}`} width={520} onClose={() => setEditUser(null)}>
              <div className="row">
                <div className="field grow"><label>Name</label><input value={editUser.name} onChange={(e) => setEditUser({ ...editUser, name: e.target.value })} /></div>
              </div>
              <div className="row">
                <div className="field grow"><label>Email</label><input value={editUser.email} onChange={(e) => setEditUser({ ...editUser, email: e.target.value })} /></div>
                <div className="field"><label>Role</label>
                  <select value={editUser.role} onChange={(e) => setEditUser({ ...editUser, role: e.target.value })}>
                    <option>admin</option><option>preparer</option><option>reviewer</option>
                  </select></div>
              </div>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="secondary" onClick={() => setEditUser(null)}>Cancel</button>
                <button onClick={saveUser}>Save changes</button>
              </div>
            </Modal>
          )}
          <h2>Add user</h2>
          <div className="row">
            <div className="field"><label>Name</label><input value={newUser.name} onChange={(e) => setNewUser({ ...newUser, name: e.target.value })} /></div>
            <div className="field"><label>Email</label><input value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} /></div>
            <div className="field"><label>Role</label>
              <select value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}>
                <option>admin</option><option>preparer</option><option>reviewer</option>
              </select></div>
            <div className="field"><label>Password (12+)</label><input type="password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} /></div>
            <button onClick={addUser}>Create</button>
          </div>
        </div>
      )}

      {tab === 'advanced' && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Filing years</h2>
          <p className="muted">The default year is preselected on new filings and pickers. Roll over to open the next year — existing years stay available for prior-year work and corrections.</p>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div className="field"><label>Default (current) year</label>
              <select value={filingYears.current || ''} onChange={(e) => setCurrentYear(Number(e.target.value))} disabled={!isAdmin}>
                {filingYears.years.map((y) => <option key={y} value={y}>{y}</option>)}
              </select></div>
            <div className="field"><label>Enabled years</label>
              <div className="row" style={{ gap: 6 }}>{filingYears.years.map((y) => (
                <span key={y} className={`badge ${y === filingYears.current ? 'ok' : 'draft'}`}>{y}</span>
              ))}</div></div>
            {isAdmin && <button onClick={rolloverYear}>Roll over to {(filingYears.current || new Date().getFullYear()) + 1}</button>}
          </div>
        </div>
      )}

      {tab === 'advanced' && (
        <div className="panel">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Audit log (latest 200)</h2>
            {isAdmin && <button className="secondary" onClick={exportAudit}>Export CSV</button>}
          </div>
          <table className="grid" style={{ marginTop: 8 }}>
            <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>IP</th></tr></thead>
            <tbody>
              {audit.map((a) => (
                <tr key={a.id}>
                  <td>{new Date(a.createdAt).toLocaleString()}</td>
                  <td>{a.actorType}</td>
                  <td className="mono">{a.action}</td>
                  <td className="mono muted">{a.entityType}{a.entityId ? `:${a.entityId.slice(0, 8)}` : ''}</td>
                  <td className="mono muted">{a.ip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'advanced' && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Background queues</h2>
          <table className="grid">
            <thead><tr><th>Queue</th><th className="num">Waiting</th><th className="num">Active</th><th className="num">Completed</th><th className="num">Failed</th></tr></thead>
            <tbody>
              {Object.entries(queues).map(([name, c]) => (
                <tr key={name}>
                  <td>{name}</td>
                  <td className="num">{c['waiting'] ?? 0}</td>
                  <td className="num">{c['active'] ?? 0}</td>
                  <td className="num">{c['completed'] ?? 0}</td>
                  <td className="num" style={{ color: c['failed'] ? 'var(--danger)' : undefined }}>{c['failed'] ?? 0}
                    {isAdmin && (c['failed'] ?? 0) > 0 && <button className="small secondary" style={{ marginLeft: 6 }} onClick={() => api.post(`/api/admin/queues/${name}/retry-failed`).then(loadAll)}>retry</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'advanced' && isAdmin && license && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>License</h2>
          <p><strong>Tier:</strong> {String(license['tier'])} &nbsp; <strong>Enforcement:</strong> {license['licenseRequired'] ? 'ON' : 'off (license_required=0)'}</p>
          <p><strong>Usage metering:</strong> {JSON.stringify(license['usage'])}</p>
          {typeof license['note'] === 'string' && <p className="muted">{license['note'] as string}</p>}
        </div>
      )}

      {tab === 'advanced' && status && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Appliance status</h2>
          <pre className="mono" style={{ background: '#f1f5f9', padding: 10, overflow: 'auto', fontSize: 11 }}>{JSON.stringify(status, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

function TemplateEditor({ value, onSave, disabled }: { value: unknown; onSave: (v: unknown) => void; disabled: boolean }) {
  const [text, setText] = useState(JSON.stringify(value ?? null, null, 2));
  const [err, setErr] = useState('');
  useEffect(() => setText(JSON.stringify(value ?? null, null, 2)), [value]);
  return (
    <div>
      {err && <div className="error-box">{err}</div>}
      <textarea rows={12} className="mono" disabled={disabled} value={text} onChange={(e) => setText(e.target.value)} />
      {!disabled && (
        <button style={{ marginTop: 8 }} onClick={() => {
          try { onSave(JSON.parse(text)); setErr(''); } catch { setErr('Invalid JSON'); }
        }}>Save templates</button>
      )}
      <p className="muted">Set to null to use the shipped defaults.</p>
    </div>
  );
}
