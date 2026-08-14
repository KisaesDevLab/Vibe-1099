import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { Paginator } from '../components/Paginator';
import { useDialogs } from '../components/Dialogs';

interface Payer {
  id: string;
  legalName: string;
  clientId: string | null;
  firstName: string | null;
  lastName: string | null;
  dbaName: string;
  tinMasked: string;
  tinType: 'SSN' | 'EIN';
  address: Record<string, string>;
  phone: string;
  contactEmail: string | null;
  contactMobile: string | null;
  moWithholdingId: string | null;
  moSourceDefault: boolean;
  filingProviderOverride: 'iris' | 'tax1099' | 'taxbandits' | null;
  defaultFormTypes: string[];
}

const emptyForm = {
  legalName: '', clientId: '', firstName: '', lastName: '', dbaName: '', tin: '', tinType: 'EIN' as 'SSN' | 'EIN',
  line1: '', line2: '', city: '', state: 'MO', zip: '',
  phone: '', contactEmail: '', contactMobile: '', moWithholdingId: '', moSourceDefault: true,
  filingProviderOverride: '' as '' | 'iris' | 'tax1099' | 'taxbandits',
  defaultFormTypes: ['NEC'] as string[],
};

export function Payers() {
  const dialogs = useDialogs();
  const [payers, setPayers] = useState<Payer[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [importPreview, setImportPreview] = useState<Array<{ row: number; status: string; name?: string; reason?: string }> | null>(null);
  const LIMIT = 100;

  const load = (off = offset, s = search) =>
    api.get<{ payers: Payer[]; total: number }>(`/api/payers?limit=${LIMIT}&offset=${off}${s ? `&search=${encodeURIComponent(s)}` : ''}`)
      .then((r) => { setPayers(r.payers); setTotal(r.total); setOffset(off); });
  useEffect(() => { void load(0); }, []);

  const parseCsv = (text: string): Array<Record<string, string>> => {
    const lines = text.trim().split(/\r?\n/);
    const headers = (lines[0] ?? '').split(',').map((h) => h.trim());
    return lines.slice(1).map((line) => {
      const cells = line.split(',').map((c) => c.trim());
      return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']));
    });
  };
  const previewImport = async () => {
    const r = await api.post<{ preview: Array<{ row: number; status: string; name?: string; reason?: string }> }>('/api/payers/import/preview', { rows: parseCsv(importText) });
    setImportPreview(r.preview);
  };
  const runImport = async () => {
    const r = await api.post<{ created: number; errors: Array<{ row: number; reason: string }> }>('/api/payers/import', { rows: parseCsv(importText) });
    dialogs.toast(`Imported ${r.created} payers${r.errors.length ? `, ${r.errors.length} errors` : ''}`, r.errors.length ? 'warning' : 'success');
    setShowImport(false); setImportPreview(null); setImportText('');
    await load(0);
  };

  const set = (k: keyof typeof emptyForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const body = {
      legalName: form.legalName,
      clientId: form.clientId || null,
      firstName: form.firstName || null,
      lastName: form.lastName || null,
      dbaName: form.dbaName,
      ...(form.tin ? { tin: form.tin, tinType: form.tinType } : editing ? {} : { tin: form.tin, tinType: form.tinType }),
      address: { line1: form.line1, line2: form.line2, city: form.city, state: form.state, zip: form.zip },
      phone: form.phone,
      contactEmail: form.contactEmail || null,
      contactMobile: form.contactMobile || null,
      moWithholdingId: form.moWithholdingId || null,
      moSourceDefault: form.moSourceDefault,
      filingProviderOverride: form.filingProviderOverride || null,
      defaultFormTypes: form.defaultFormTypes.length ? form.defaultFormTypes : ['NEC'],
    };
    try {
      if (editing) await api.patch(`/api/payers/${editing}`, body);
      else await api.post('/api/payers', body);
      setForm(emptyForm);
      setShowForm(false);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}${err.details ? ' — ' + JSON.stringify(err.details) : ''}` : String(err));
    }
  };

  const edit = (p: Payer) => {
    setEditing(p.id);
    setShowForm(true);
    setForm({
      legalName: p.legalName, clientId: p.clientId ?? '', firstName: p.firstName ?? '', lastName: p.lastName ?? '',
      dbaName: p.dbaName, tin: '', tinType: p.tinType,
      line1: p.address['line1'] ?? '', line2: p.address['line2'] ?? '', city: p.address['city'] ?? '',
      state: p.address['state'] ?? 'MO', zip: p.address['zip'] ?? '',
      phone: p.phone, contactEmail: p.contactEmail ?? '', contactMobile: p.contactMobile ?? '',
      moWithholdingId: p.moWithholdingId ?? '', moSourceDefault: p.moSourceDefault,
      filingProviderOverride: p.filingProviderOverride ?? '',
      defaultFormTypes: p.defaultFormTypes ?? ['NEC'],
    });
  };

  const toggleFormType = (t: string) =>
    setForm((f) => ({ ...f, defaultFormTypes: f.defaultFormTypes.includes(t) ? f.defaultFormTypes.filter((x) => x !== t) : [...f.defaultFormTypes, t] }));

  const revealTin = async (id: string) => {
    const r = await api.post<{ tin: string }>(`/api/payers/${id}/reveal-tin`);
    await dialogs.reveal('Payer TIN (reveal recorded in the audit log)', r.tin);
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Payers</h1>
        <div>
          <button className="secondary" style={{ marginRight: 8 }} onClick={() => setShowImport(!showImport)}>CSV import</button>
          <button onClick={() => { setShowForm(!showForm); setEditing(null); setForm(emptyForm); }}>
            {showForm ? 'Cancel' : '+ Add payer'}
          </button>
        </div>
      </div>
      {error && <div className="error-box">{error}</div>}

      <div className="panel">
        <div className="row">
          <div className="field grow"><label>Search payers</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load(0, search)} placeholder="Client ID, name, or DBA…" /></div>
          <button className="secondary" onClick={() => load(0, search)}>Search</button>
        </div>
      </div>

      {showImport && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Payer CSV import (onboard many at once)</h2>
          <p className="muted">Header row: clientId,firstName,lastName,legalName,dbaName,tin,tinType,line1,line2,city,state,zip,phone,contactEmail,contactMobile,moWithholdingId,defaultFormTypes (e.g. NEC|MISC). Provide <strong>legalName</strong> for businesses, or <strong>firstName + lastName</strong> for individuals.</p>
          <textarea rows={6} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="clientId,firstName,lastName,legalName,dbaName,tin,..." />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="secondary" onClick={previewImport}>Preview</button>
            {importPreview && <button onClick={runImport}>Import {importPreview.filter((p) => p.status !== 'invalid').length} payers</button>}
          </div>
          {importPreview && (
            <table className="grid" style={{ marginTop: 8 }}>
              <thead><tr><th>Row</th><th>Status</th><th>Name</th><th>Note</th></tr></thead>
              <tbody>
                {importPreview.map((p) => (
                  <tr key={p.row}><td>{p.row}</td>
                    <td><span className={`badge ${p.status === 'invalid' ? 'err' : p.status === 'existing' ? 'warn' : 'ok'}`}>{p.status}</span></td>
                    <td>{p.name}</td><td>{p.reason}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {showForm && (
        <form className="panel" onSubmit={submit}>
          <div className="row">
            <div className="field"><label>Client ID</label><input value={form.clientId} onChange={set('clientId')} placeholder="Your practice ID" /></div>
            <div className="field grow"><label>First name</label><input value={form.firstName} onChange={set('firstName')} placeholder="Individual payer" /></div>
            <div className="field grow"><label>Last name</label><input value={form.lastName} onChange={set('lastName')} /></div>
          </div>
          <div className="row">
            <div className="field grow"><label>Legal name <span className="muted">(businesses; leave blank to use First + Last)</span></label><input value={form.legalName} onChange={set('legalName')} /></div>
            <div className="field grow"><label>DBA (optional)</label><input value={form.dbaName} onChange={set('dbaName')} /></div>
          </div>
          <div className="row">
            <div className="field"><label>{editing ? 'TIN (leave blank to keep)' : 'TIN'}</label><input value={form.tin} onChange={set('tin')} placeholder="XX-XXXXXXX" required={!editing} /></div>
            <div className="field"><label>TIN type</label>
              <select value={form.tinType} onChange={set('tinType')}><option>EIN</option><option>SSN</option></select>
            </div>
            <div className="field"><label>MO withholding ID</label><input value={form.moWithholdingId} onChange={set('moWithholdingId')} /></div>
            <div className="field"><label>MO-source default</label>
              <select value={form.moSourceDefault ? '1' : '0'} onChange={(e) => setForm((f) => ({ ...f, moSourceDefault: e.target.value === '1' }))}>
                <option value="1">Yes</option><option value="0">No</option>
              </select>
            </div>
            <div className="field"><label>Filing backend</label>
              <select value={form.filingProviderOverride} onChange={(e) => setForm((f) => ({ ...f, filingProviderOverride: e.target.value as '' | 'iris' | 'tax1099' | 'taxbandits' }))}>
                <option value="">Firm default</option>
                <option value="iris">IRIS (self-file)</option>
                <option value="tax1099">Tax1099 (managed)</option>
                <option value="taxbandits">TaxBandits (managed)</option>
              </select>
            </div>
            <div className="field">
              <label>Default form types (preset for invites)</label>
              <div className="row" style={{ gap: 8 }}>
                {['NEC', 'MISC', 'INT', 'DIV'].map((t) => (
                  <label key={t} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 13, color: 'var(--text)' }}>
                    <input type="checkbox" style={{ width: 'auto' }} checked={form.defaultFormTypes.includes(t)} onChange={() => toggleFormType(t)} /> {t}
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div className="row">
            <div className="field grow"><label>Address line 1</label><input value={form.line1} onChange={set('line1')} required /></div>
            <div className="field grow"><label>Line 2</label><input value={form.line2} onChange={set('line2')} /></div>
          </div>
          <div className="row">
            <div className="field grow"><label>City</label><input value={form.city} onChange={set('city')} required /></div>
            <div className="field" style={{ maxWidth: 70 }}><label>State</label><input value={form.state} onChange={set('state')} maxLength={2} required /></div>
            <div className="field" style={{ maxWidth: 120 }}><label>ZIP</label><input value={form.zip} onChange={set('zip')} required /></div>
            <div className="field"><label>Phone</label><input value={form.phone} onChange={set('phone')} /></div>
          </div>
          <div className="row">
            <div className="field grow"><label>Contact email (client invites)</label><input value={form.contactEmail} onChange={set('contactEmail')} type="email" /></div>
            <div className="field grow"><label>Contact mobile</label><input value={form.contactMobile} onChange={set('contactMobile')} /></div>
          </div>
          <button type="submit">{editing ? 'Save changes' : 'Create payer'}</button>
        </form>
      )}

      <table className="grid">
        <thead><tr><th>Client ID</th><th>Name</th><th>TIN</th><th>City</th><th>Contact</th><th></th></tr></thead>
        <tbody>
          {payers.map((p) => (
            <tr key={p.id}>
              <td className="mono">{p.clientId ?? <span className="muted">—</span>}</td>
              <td>{p.legalName}{p.dbaName && <span className="muted"> dba {p.dbaName}</span>}</td>
              <td className="mono">{p.tinMasked} <button className="small secondary" onClick={() => revealTin(p.id)}>reveal</button></td>
              <td>{p.address['city']}, {p.address['state']}</td>
              <td>{p.contactEmail ?? p.contactMobile ?? <span className="muted">—</span>}</td>
              <td><button className="small secondary" onClick={() => edit(p)}>Edit</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <Paginator total={total} limit={LIMIT} offset={offset} onChange={(o) => load(o, search)} unit="payers" />
    </div>
  );
}
