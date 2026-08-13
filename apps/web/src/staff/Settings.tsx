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
  impositionOffsetX16: number; impositionOffsetY16: number;
}
interface IrisSettings {
  tcc: string; apiClientId: string; hasJwk: boolean; publicJwk: Record<string, unknown> | null; environment: 'ATS' | 'PROD';
  filingProvider: 'iris' | 'tax1099' | 'taxbandits';
  tax1099Environment: 'sandbox' | 'production';
  tax1099Mailing: boolean;
  hasTax1099Key: boolean;
  tax1099ApiKey?: string; // transient input only
  tax1099DisclosureAckAt: string | null;
  acknowledgeTax1099Disclosure?: boolean; // transient input only
  // TaxBandits backend
  taxbanditsEnabled: boolean;
  taxbanditsEnvironment: 'sandbox' | 'production';
  taxbanditsPostalMailing: boolean;
  taxbanditsOnlineAccess: boolean;
  hasTaxbanditsCreds: boolean;
  taxbanditsDisclosureAckAt: string | null;
  taxbanditsWebhookUrl: string;
  taxbanditsClientId?: string; // transient
  taxbanditsClientSecret?: string; // transient
  taxbanditsUserToken?: string; // transient
  acknowledgeTaxbanditsDisclosure?: boolean; // transient
}
interface WebhookEvent {
  eventType: string;
  submissionId: string | null;
  status: string | null;
  receivedAt: string;
  processedAt: string | null;
}
interface WebhookAnomaly { at: string; ip: string; kind: 'rejected' | 'accepted_offlist_ip'; reason: string }
interface CloudflareInfo {
  hasToken: boolean;
  hostname: string;
  inAppTunnel: boolean;
  status: { running: boolean; readyConnections: number | null; detail: string } | null;
  publicPaths: Array<{ path: string; desc: string }>;
  portalBaseUrl: string;
  token?: string; // transient input
}
interface User { id: string; email: string; name: string; role: string; active: boolean; totpEnabled: boolean; lastLoginAt: string | null }
interface AuditEntry { id: number; createdAt: string; actorType: string; actorId: string | null; action: string; entityType: string; entityId: string | null; ip: string | null }

export function Settings() {
  const me = useOutletContext<Me>();
  const dialogs = useDialogs();
  const [tab, setTab] = useState<'firm' | 'efile' | 'delivery' | 'users' | 'network' | 'advanced'>('firm');
  const [firm, setFirm] = useState<Firm | null>(null);
  const [iris, setIris] = useState<IrisSettings | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [queues, setQueues] = useState<Record<string, Record<string, number>>>({});
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [newUser, setNewUser] = useState({ email: '', name: '', role: 'preparer', password: '' });
  const [webhookEvents, setWebhookEvents] = useState<WebhookEvent[]>([]);
  const [webhookAnomalies, setWebhookAnomalies] = useState<WebhookAnomaly[]>([]);
  const [webhookTest, setWebhookTest] = useState<{ running?: boolean; ok?: boolean; status?: number; error?: string } | null>(null);
  const [cf, setCf] = useState<CloudflareInfo | null>(null);
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
    }
    api.get<{ queues: Record<string, Record<string, number>> }>('/api/admin/queues').then((r) => setQueues(r.queues)).catch(() => {});
    // /api/status returns 503 when a bundled dependency (postgres/redis/render/
    // queues) is down; IRIS reachability is informational and never flips it.
    // Read the body regardless so the panel shows the degraded detail — including
    // IRIS status — exactly when it's most useful.
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
        taxbanditsEnabled: iris.taxbanditsEnabled,
        taxbanditsEnvironment: iris.taxbanditsEnvironment,
        taxbanditsPostalMailing: iris.taxbanditsPostalMailing,
        taxbanditsOnlineAccess: iris.taxbanditsOnlineAccess,
        ...(iris.taxbanditsClientId ? { taxbanditsClientId: iris.taxbanditsClientId } : {}),
        ...(iris.taxbanditsClientSecret ? { taxbanditsClientSecret: iris.taxbanditsClientSecret } : {}),
        ...(iris.taxbanditsUserToken ? { taxbanditsUserToken: iris.taxbanditsUserToken } : {}),
        ...(iris.acknowledgeTaxbanditsDisclosure ? { acknowledgeTaxbanditsDisclosure: true } : {}),
      });
      setIris((i) => (i ? {
        ...i,
        tax1099ApiKey: '', acknowledgeTax1099Disclosure: false,
        hasTax1099Key: i.hasTax1099Key || !!i.tax1099ApiKey,
        tax1099DisclosureAckAt: i.tax1099DisclosureAckAt ?? (i.acknowledgeTax1099Disclosure ? new Date().toISOString() : null),
        taxbanditsClientId: '', taxbanditsClientSecret: '', taxbanditsUserToken: '', acknowledgeTaxbanditsDisclosure: false,
        hasTaxbanditsCreds: i.hasTaxbanditsCreds || !!(i.taxbanditsClientId && i.taxbanditsClientSecret && i.taxbanditsUserToken),
        taxbanditsDisclosureAckAt: i.taxbanditsDisclosureAckAt ?? (i.acknowledgeTaxbanditsDisclosure ? new Date().toISOString() : null),
      } : i));
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

  const loadCloudflare = async () => {
    try { setCf(await api.get<CloudflareInfo>('/api/admin/cloudflare')); }
    catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
  };
  const saveCloudflare = async () => {
    if (!cf) return;
    try {
      await api.put('/api/admin/cloudflare', { ...(cf.token ? { token: cf.token } : {}), hostname: cf.hostname });
      dialogs.toast('Saved. If you changed the token, restart the tunnel: docker compose restart cloudflared', 'success');
      await loadCloudflare();
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
  };

  const loadWebhookEvents = async () => {
    try {
      const r = await api.get<{ events: WebhookEvent[]; anomalies: WebhookAnomaly[] }>('/api/iris/taxbandits/webhook-events');
      setWebhookEvents(r.events);
      setWebhookAnomalies(r.anomalies ?? []);
      if (!r.events.length && !(r.anomalies ?? []).length) dialogs.toast('No webhook events received yet.', 'info');
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
  };

  const testWebhookUrl = async () => {
    setWebhookTest({ running: true });
    try {
      const r = await api.post<{ ok: boolean; status: number; url: string; error?: string }>('/api/iris/taxbandits/webhook-test', {});
      setWebhookTest(r);
    } catch (err) {
      setWebhookTest({ ok: false, status: 0, error: err instanceof ApiError ? err.message : String(err) });
    }
  };

  const loadSandboxSeed = async () => {
    const ok = await dialogs.confirm(
      'Load 10 fabricated payers + 30 recipients with TY2026 draft forms for TaxBandits SANDBOX testing? They mix into your real payer list until you remove them (Remove test data deletes EVERYTHING, so on a production firm delete the 10 test payers individually instead).',
      { title: 'Load sandbox test data' },
    );
    if (!ok) return;
    try {
      const r = await api.post<{ created: { payers: number; recipients: number; forms: number }; taxYear: number }>('/api/admin/sandbox-seed', {});
      dialogs.toast(`Sandbox data loaded: +${r.created.payers} payers, +${r.created.recipients} recipients, +${r.created.forms} TY${r.taxYear} draft forms.`, 'success');
      loadAll();
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
  };

  const resetTestData = async () => {
    const ok = await dialogs.confirm(
      'This permanently deletes ALL payers, recipients, forms, transmissions, deliveries, batches, W-9s, and generated documents for this firm. Your firm settings, users, and audit log are kept. This cannot be undone.',
      { title: 'Remove test data', danger: true },
    );
    if (!ok) return;
    const phrase = await dialogs.prompt('Type REMOVE TEST DATA to confirm:', { title: 'Confirm removal' });
    if (phrase !== 'REMOVE TEST DATA') { if (phrase !== null) dialogs.toast('Confirmation phrase did not match — nothing deleted.', 'warning'); return; }
    try {
      const r = await api.post<{ deleted: Record<string, number> }>('/api/admin/reset-test-data', { confirm: phrase });
      const d = r.deleted;
      dialogs.toast(`Removed ${d.payers} payers, ${d.recipients} recipients, ${d.formRecords} forms, ${d.transmissions} transmissions, ${d.blobs} documents.`, 'success');
      loadAll();
    } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
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
          ['network', 'Public access'],
          ['advanced', 'Advanced'],
        ] as const).map(([t, label]) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => { setTab(t); if (t === 'advanced') void loadAudit(); if (t === 'network') void loadCloudflare(); }}>{label}</button>
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
              <select value={iris.filingProvider} onChange={(e) => setIris({ ...iris, filingProvider: e.target.value as 'iris' | 'tax1099' | 'taxbandits' })}>
                <option value="iris">IRIS A2A — we are the Transmitter (needs our TCC)</option>
                <option value="tax1099">Tax1099 (Zenwork) — files on our behalf (no TCC)</option>
                <option value="taxbandits">TaxBandits — files on our behalf (no TCC; TCC-pending contingency)</option>
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

          {iris.filingProvider === 'taxbandits' && (
            <div className="panel" style={{ background: '#eff6ff', borderColor: '#bfdbfe' }}>
              <h2 style={{ marginTop: 0 }}>TaxBandits (SPAN Enterprises)</h2>
              <p className="muted">Contingency transmitter for firms whose IRS TCC is still pending. Prepaid-credit billing; corrections always stay on the provider that filed the original.</p>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 8 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={iris.taxbanditsEnabled}
                  onChange={(e) => setIris({ ...iris, taxbanditsEnabled: e.target.checked })} /> Enable TaxBandits for this firm
              </label>
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <div className="field grow"><label>Client ID {iris.hasTaxbanditsCreds && <span className="muted">(saved — leave blank to keep)</span>}</label>
                  <input type="password" placeholder={iris.hasTaxbanditsCreds ? '••••••••' : 'TaxBandits Client ID'} value={iris.taxbanditsClientId ?? ''}
                    onChange={(e) => setIris({ ...iris, taxbanditsClientId: e.target.value })} /></div>
                <div className="field grow"><label>Client Secret</label>
                  <input type="password" placeholder={iris.hasTaxbanditsCreds ? '••••••••' : 'Client Secret'} value={iris.taxbanditsClientSecret ?? ''}
                    onChange={(e) => setIris({ ...iris, taxbanditsClientSecret: e.target.value })} /></div>
                <div className="field grow"><label>User Token</label>
                  <input type="password" placeholder={iris.hasTaxbanditsCreds ? '••••••••' : 'User Token'} value={iris.taxbanditsUserToken ?? ''}
                    onChange={(e) => setIris({ ...iris, taxbanditsUserToken: e.target.value })} /></div>
              </div>
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <div className="field"><label>Environment</label>
                  <select value={iris.taxbanditsEnvironment} onChange={(e) => setIris({ ...iris, taxbanditsEnvironment: e.target.value as 'sandbox' | 'production' })}>
                    <option value="sandbox">Sandbox (test)</option><option value="production">Production</option>
                  </select></div>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={iris.taxbanditsPostalMailing}
                    onChange={(e) => setIris({ ...iris, taxbanditsPostalMailing: e.target.checked })} /> USPS mail (add-on)
                </label>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={iris.taxbanditsOnlineAccess}
                    onChange={(e) => setIris({ ...iris, taxbanditsOnlineAccess: e.target.checked })} /> Online access (add-on)
                </label>
                <button onClick={saveIris}>Save</button>
              </div>
              {iris.taxbanditsEnvironment === 'sandbox' && <div className="warn-box">Sandbox — submissions are TEST filings, not sent to the IRS.</div>}
              <div className="panel" style={{ background: '#fff', marginTop: 10 }}>
                <h3 style={{ marginTop: 0 }}>Status webhooks</h3>
                <p className="muted" style={{ marginTop: 0 }}>Register this URL in the TaxBandits developer console (Settings → Webhooks — their form asks only for the callback URL and a notification email). TaxBandits will POST a sample payload to validate the URL; it activates once the appliance answers 200. The appliance also polls as a fallback, so webhooks are optional but recommended.</p>
                <div className="field"><label>Webhook URL</label>
                  <div className="row" style={{ gap: 8 }}>
                    <input className="mono" readOnly value={iris.taxbanditsWebhookUrl} onFocus={(e) => e.target.select()} />
                    <button type="button" className="secondary" onClick={() => { void navigator.clipboard?.writeText(iris.taxbanditsWebhookUrl); dialogs.toast('Copied', 'success'); }}>Copy</button>
                    <button type="button" className="secondary" disabled={!!webhookTest?.running} onClick={() => void testWebhookUrl()}>{webhookTest?.running ? 'Testing…' : 'Test reachability'}</button>
                  </div>
                </div>
                {webhookTest && !webhookTest.running && (
                  webhookTest.ok
                    ? <div className="ok-box">Reachable ✓ — the public URL answered from the appliance (same round trip TaxBandits' validation ping takes).</div>
                    : <div className="error-box">Not reachable{webhookTest.status ? ` (HTTP ${webhookTest.status})` : ''}{webhookTest.error ? ` — ${webhookTest.error}` : ''}. Check PORTAL_BASE_URL and the tunnel under Settings → Public access.</div>
                )}
                <ul className="muted" style={{ margin: '6px 0', paddingLeft: 18 }}>
                  <li>{iris.taxbanditsWebhookUrl.startsWith('https://')
                    ? <>URL is public https ✓</>
                    : <span style={{ color: '#b91c1c' }}>URL is not a public https address — set <span className="mono">PORTAL_BASE_URL</span> to your public hostname and restart, or TaxBandits cannot reach it.</span>}</li>
                  <li>{iris.hasTaxbanditsCreds
                    ? <>Client ID/Secret saved ✓ — deliveries are verified against them (HMAC signature; nothing to configure in their console)</>
                    : <span style={{ color: '#b91c1c' }}>Save your Client ID/Secret above <b>before</b> registering the URL — TaxBandits' validation ping is signature-checked against them.</span>}</li>
                  <li>Their console asks only for this URL + a notification email; activation requires our 200 response to their sample POST.</li>
                </ul>
                <button type="button" className="secondary" onClick={loadWebhookEvents}>Show recent events</button>
                {webhookEvents.length > 0 && (
                  <table className="grid" style={{ marginTop: 8, fontSize: 12 }}>
                    <thead><tr><th>Event</th><th>Submission</th><th>Status</th><th>Received</th></tr></thead>
                    <tbody>{webhookEvents.map((e, i) => (
                      <tr key={i}><td>{e.eventType}</td><td className="mono">{e.submissionId?.slice(0, 12) ?? ''}</td><td>{e.status ?? ''}</td><td>{new Date(e.receivedAt).toLocaleString()}</td></tr>
                    ))}</tbody>
                  </table>
                )}
                {webhookAnomalies.length > 0 && (
                  <>
                    <p className="muted" style={{ margin: '10px 0 4px' }}>Recent delivery problems (since last API restart) — a <span className="mono">rejected</span> row means the signature didn’t verify:</p>
                    <table className="grid" style={{ fontSize: 12 }}>
                      <thead><tr><th>When</th><th>From IP</th><th>Kind</th><th>Reason</th></tr></thead>
                      <tbody>{webhookAnomalies.map((a, i) => (
                        <tr key={i}><td>{new Date(a.at).toLocaleString()}</td><td className="mono">{a.ip}</td><td>{a.kind === 'rejected' ? <span className="badge warn">rejected</span> : <span className="badge ok">accepted</span>}</td><td>{a.reason}</td></tr>
                      ))}</tbody>
                    </table>
                  </>
                )}
              </div>
              {iris.taxbanditsDisclosureAckAt ? (
                <p className="muted" style={{ marginBottom: 0 }}>§7216 disclosure acknowledged on {new Date(iris.taxbanditsDisclosureAckAt).toLocaleDateString()}. Recipient TINs, addresses, and amounts are transmitted to SPAN Enterprises (TaxBandits) to file on the payer's behalf.</p>
              ) : (
                <div className="warn-box">
                  <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <input type="checkbox" style={{ width: 'auto', marginTop: 3 }} checked={!!iris.acknowledgeTaxbanditsDisclosure}
                      onChange={(e) => setIris({ ...iris, acknowledgeTaxbanditsDisclosure: e.target.checked })} />
                    <span>I acknowledge that filing through TaxBandits discloses recipient TINs (SSNs/EINs), names, addresses, and dollar amounts to SPAN Enterprises, Inc. as an auxiliary service provider under Treas. Reg. §301.7216-2(d). Filing stays disabled until this is accepted.</span>
                  </label>
                </div>
              )}
            </div>
          )}

          {iris.filingProvider === 'iris' && (<>
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
          </>)}
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

      {tab === 'network' && isAdmin && cf && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Public access (Cloudflare Tunnel)</h2>
          <p className="muted">The public pages (recipient portal, W-9, client portal) and provider webhooks reach the internet only through a Cloudflare Tunnel — no inbound ports are opened.</p>

          {cf.inAppTunnel ? (<>
            <div className="panel" style={{ background: cf.status?.running ? '#f0fdf4' : '#fef2f2', borderColor: cf.status?.running ? '#bbf7d0' : '#fecaca' }}>
              <strong>Tunnel status:</strong>{' '}
              {cf.status?.running ? <span style={{ color: '#15803d' }}>connected ✓</span> : <span style={{ color: '#b91c1c' }}>not connected</span>}
              <div className="muted" style={{ fontSize: 12 }}>{cf.status?.detail}</div>
              <button type="button" className="secondary" style={{ marginTop: 6 }} onClick={loadCloudflare}>Refresh</button>
            </div>

            <h3>Setup</h3>
            <ol className="muted" style={{ lineHeight: 1.6 }}>
              <li>In the <strong>Cloudflare Zero Trust dashboard</strong> → Networks → Tunnels, create a tunnel (choose <em>cloudflared</em>) and copy its <strong>token</strong>.</li>
              <li>Add a <strong>public hostname</strong> for the tunnel (e.g. <span className="mono">{cf.hostname || '1099.yourfirm.com'}</span>) routing to the web service <span className="mono">http://web:8211</span>. Cloudflare manages DNS automatically.</li>
              <li>Paste the token here and Save, then restart the tunnel: <span className="mono">docker compose restart cloudflared</span>.</li>
              <li>Set <span className="mono">PORTAL_BASE_URL</span> and <span className="mono">APP_BASE_URL</span> to <span className="mono">https://{cf.hostname || 'your-hostname'}</span> so emailed links and webhook URLs use it.</li>
            </ol>

            <div className="row" style={{ alignItems: 'flex-end' }}>
              <div className="field grow"><label>Tunnel token {cf.hasToken && <span className="muted">(saved — leave blank to keep)</span>}</label>
                <input type="password" placeholder={cf.hasToken ? '••••••••' : 'Cloudflare tunnel token'} value={cf.token ?? ''}
                  onChange={(e) => setCf({ ...cf, token: e.target.value })} /></div>
              <div className="field grow"><label>Public hostname</label>
                <input placeholder="1099.yourfirm.com" value={cf.hostname} onChange={(e) => setCf({ ...cf, hostname: e.target.value })} /></div>
              <button onClick={saveCloudflare}>Save</button>
            </div>
          </>) : (
            <div className="panel" style={{ background: '#eff6ff', borderColor: '#bfdbfe' }}>
              <h3 style={{ marginTop: 0 }}>Managed at the appliance level</h3>
              <p className="muted" style={{ marginTop: 0 }}>This deployment doesn't run its own tunnel. On the <strong>Vibe Appliance</strong>, public ingress is handled by the shared <strong>Caddy</strong> reverse proxy in front of a <em>path-restricted</em> Cloudflare Tunnel — configure it there (see <span className="mono">docs/appliance-integration.md</span>). Allowlist exactly the public paths below; everything else stays private (Caddy returns 404), so the staff app is never exposed.</p>
              <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Running Vibe 1099 <strong>standalone</strong> instead? Set <span className="mono">INAPP_TUNNEL_ENABLED=1</span> and start with <span className="mono">docker compose --profile tunnel up</span> to manage the tunnel from this screen.</p>
            </div>
          )}

          <h3>Public surface</h3>
          <p className="muted">Recipients and clients open the <strong>browser pages</strong> below; each page then calls its matching <span className="mono">/api</span> route (nginx proxies <span className="mono">/api</span> to the API). Webhooks are server-to-server. Everything else — the staff app and its APIs — needs a login.</p>
          <table className="grid" style={{ maxWidth: 600 }}>
            <thead><tr><th>Path</th><th>What it is</th></tr></thead>
            <tbody>{cf.publicPaths.map((p) => (
              <tr key={p.path}><td className="mono">{p.path}</td><td>{p.desc}</td></tr>
            ))}</tbody>
          </table>
          {cf.inAppTunnel ? (
            <div className="warn-box" style={{ marginTop: 8 }}>
              The in-app tunnel routes the <strong>whole hostname</strong> to the web service, so the staff app is also reachable at this hostname (behind login). To keep staff private, add a <strong>Cloudflare Access</strong> policy that bypasses only the public paths above and requires auth for the rest — or serve staff on a separate, non-tunneled hostname (LAN/Tailscale).
            </div>
          ) : (
            <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>On the appliance, Caddy exposes only these paths through the tunnel and returns 404 for everything else, so the staff app stays private.</p>
          )}
          <p className="muted" style={{ fontSize: 12 }}>Current PORTAL_BASE_URL: <span className="mono">{cf.portalBaseUrl}</span></p>
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

      {tab === 'advanced' && status && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Appliance status</h2>
          <pre className="mono" style={{ background: '#f1f5f9', padding: 10, overflow: 'auto', fontSize: 11 }}>{JSON.stringify(status, null, 2)}</pre>
        </div>
      )}

      {tab === 'advanced' && isAdmin && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Sandbox test data</h2>
          <p className="muted">
            Loads 10 test payers + 30 recipients with TY2026 draft forms whose TINs script the TaxBandits <b>sandbox</b> simulation:
            most accept, one payer rejects three ways (TIN error / huge amount / excess withholding), one has a state rejection, one stays
            stuck TRANSMITTED, one returns accepted-with-errors, and ELLIS PARK fails TIN matching. Each form's notes state its expected
            outcome. Idempotent — re-running never duplicates. Refuses to load while TaxBandits is set to production. Clean up afterwards
            with “Remove test data” below.
          </p>
          <button className="secondary" onClick={() => void loadSandboxSeed()}>Load sandbox test data</button>
        </div>
      )}

      {tab === 'advanced' && isAdmin && (
        <div className="panel" style={{ borderColor: '#fecaca', background: '#fef2f2' }}>
          <h2 style={{ marginTop: 0, color: '#b91c1c' }}>Danger zone</h2>
          <p className="muted">Remove all test data before starting a real filing season. Deletes every payer, recipient, form, transmission, delivery, batch, W-9, and generated document for this firm. Keeps your firm settings, e-file credentials, users, and the audit log.</p>
          <button className="danger" onClick={resetTestData}>Remove test data</button>
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
