import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError } from '../api';

export interface Recipient {
  id: string;
  tinMasked: string;
  tinType: 'SSN' | 'EIN';
  isItin: boolean;
  name1: string;
  name2: string;
  address: Record<string, string>;
  email: string | null;
  mobile: string | null;
  w9Status: string;
  backupWithholding: boolean;
}

interface VaultMatch {
  recipientId: string;
  name1: string;
  address: Record<string, string>;
  tinMasked: string;
  w9Status: string;
  lastUsed: { payerName: string; taxYear: number; formType: string } | null;
}

const emptyForm = {
  tin: '', tinType: 'SSN' as 'SSN' | 'EIN', name1: '', name2: '',
  line1: '', line2: '', city: '', state: 'MO', zip: '',
  email: '', mobile: '', backupWithholding: false,
};

export function Recipients() {
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [form, setForm] = useState(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [match, setMatch] = useState<VaultMatch | null>(null);
  const [error, setError] = useState('');
  const [importText, setImportText] = useState('');
  const [importPreview, setImportPreview] = useState<Array<{ row: number; status: string; name?: string; reason?: string; matchName?: string }> | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [mergeFrom, setMergeFrom] = useState('');
  const [mergeTo, setMergeTo] = useState('');
  const [history, setHistory] = useState<Array<{ name1: string; address: Record<string, string>; source: string; createdAt: string }> | null>(null);

  const load = () =>
    api
      .get<{ recipients: Recipient[] }>(`/api/recipients?filter=${filter}${search ? `&search=${encodeURIComponent(search)}` : ''}`)
      .then((r) => setRecipients(r.recipients));
  // reload on filter change; search triggers explicitly
  useEffect(() => { void load(); }, [filter]);

  const set = (k: keyof typeof emptyForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // lookup-as-you-type: fires when 9 digits present
  const onTinChange = async (value: string) => {
    setForm((f) => ({ ...f, tin: value }));
    const digits = value.replace(/\D/g, '');
    if (digits.length === 9 && !editing) {
      try {
        const r = await api.get<{ match: VaultMatch | null }>(`/api/recipients/lookup?tin=${digits}&tinType=${form.tinType}`);
        setMatch(r.match);
      } catch { setMatch(null); }
    } else setMatch(null);
  };

  const useMatch = () => {
    if (!match) return;
    setEditing(match.recipientId);
    setForm((f) => ({
      ...f,
      name1: match.name1,
      line1: match.address['line1'] ?? '',
      line2: match.address['line2'] ?? '',
      city: match.address['city'] ?? '',
      state: match.address['state'] ?? 'MO',
      zip: match.address['zip'] ?? '',
    }));
    setMatch(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const body = {
      ...(form.tin ? { tin: form.tin, tinType: form.tinType } : {}),
      name1: form.name1, name2: form.name2,
      address: { line1: form.line1, line2: form.line2, city: form.city, state: form.state, zip: form.zip },
      email: form.email || null, mobile: form.mobile || null,
      backupWithholding: form.backupWithholding,
    };
    try {
      if (editing) await api.patch(`/api/recipients/${editing}`, body);
      else await api.post('/api/recipients', body);
      setForm(emptyForm); setShowForm(false); setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}${err.details ? ' — ' + JSON.stringify(err.details) : ''}` : String(err));
    }
  };

  const revealTin = async (id: string) => {
    const r = await api.post<{ tin: string }>(`/api/recipients/${id}/reveal-tin`);
    alert(`TIN: ${r.tin}\n(reveal recorded in the audit log)`);
  };

  const showHistory = async (id: string) => {
    const r = await api.get<{ history: Array<{ name1: string; address: Record<string, string>; source: string; createdAt: string }> }>(`/api/recipients/${id}/history`);
    setHistory(r.history);
  };

  const requestW9 = async (r: Recipient) => {
    const email = r.email ?? prompt('Recipient email for the W-9 request:');
    if (!email) return;
    await api.post('/api/w9/requests', { recipientId: r.id, email });
    alert('W-9 request sent.');
    await load();
  };

  const parseCsv = (text: string): Array<Record<string, string>> => {
    const lines = text.trim().split(/\r?\n/);
    const headers = (lines[0] ?? '').split(',').map((h) => h.trim());
    return lines.slice(1).map((line) => {
      const cells = line.split(',').map((c) => c.trim());
      return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']));
    });
  };

  const previewImport = async () => {
    const rows = parseCsv(importText);
    const r = await api.post<{ preview: Array<{ row: number; status: string; name?: string; reason?: string; matchName?: string }> }>('/api/recipients/import/preview', { rows });
    setImportPreview(r.preview);
  };

  const runImport = async (updateExisting: boolean) => {
    const rows = parseCsv(importText);
    const r = await api.post<{ created: number; updated: number; skipped: number; errors: Array<{ row: number; reason: string }> }>('/api/recipients/import', { rows, updateExisting });
    alert(`Import: ${r.created} created, ${r.updated} updated, ${r.skipped} skipped, ${r.errors.length} errors`);
    setShowImport(false); setImportPreview(null); setImportText('');
    await load();
  };

  const merge = async () => {
    if (!mergeFrom || !mergeTo) return;
    const r = await api.post<{ movedForms: number }>('/api/recipients/merge', { survivorId: mergeTo, duplicateId: mergeFrom });
    alert(`Merged — ${r.movedForms} form record(s) re-pointed.`);
    setMergeFrom(''); setMergeTo('');
    await load();
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Recipient vault</h1>
        <div>
          <button className="secondary" style={{ marginRight: 8 }} onClick={() => setShowImport(!showImport)}>CSV import</button>
          <button onClick={() => { setShowForm(!showForm); setEditing(null); setForm(emptyForm); setMatch(null); }}>
            {showForm ? 'Cancel' : '+ Add recipient'}
          </button>
        </div>
      </div>
      {error && <div className="error-box">{error}</div>}

      {showImport && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>CSV import</h2>
          <p className="muted">Header row: tin,tinType,name1,name2,line1,line2,city,state,zip,email,mobile</p>
          <textarea rows={6} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="tin,tinType,name1,..." />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="secondary" onClick={previewImport}>Preview (dedupe by TIN)</button>
            {importPreview && (
              <>
                <button onClick={() => runImport(false)}>Import new only</button>
                <button onClick={() => runImport(true)}>Import + update existing</button>
              </>
            )}
          </div>
          {importPreview && (
            <table className="grid" style={{ marginTop: 8 }}>
              <thead><tr><th>Row</th><th>Status</th><th>Name</th><th>Note</th></tr></thead>
              <tbody>
                {importPreview.map((p) => (
                  <tr key={p.row}>
                    <td>{p.row}</td>
                    <td><span className={`badge ${p.status === 'invalid' ? 'err' : p.status === 'existing' ? 'warn' : 'ok'}`}>{p.status}</span></td>
                    <td>{p.name}</td>
                    <td>{p.reason ?? (p.matchName ? `matches vault: ${p.matchName}` : '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {showForm && (
        <form className="panel" onSubmit={submit}>
          <div className="row">
            <div className="field"><label>{editing ? 'TIN (blank = keep)' : 'TIN (lookup fires at 9 digits)'}</label>
              <input value={form.tin} onChange={(e) => onTinChange(e.target.value)} required={!editing} /></div>
            <div className="field"><label>Type</label>
              <select value={form.tinType} onChange={set('tinType')}><option>SSN</option><option>EIN</option></select></div>
            <div className="field"><label>Backup withholding</label>
              <select value={form.backupWithholding ? '1' : '0'} onChange={(e) => setForm((f) => ({ ...f, backupWithholding: e.target.value === '1' }))}>
                <option value="0">No</option><option value="1">Yes</option>
              </select></div>
          </div>
          {match && (
            <div className="warn-box">
              Vault match: <strong>{match.name1}</strong> at {match.address['line1']}, {match.address['city']}
              {match.lastUsed && <> — last used {match.lastUsed.taxYear} 1099-{match.lastUsed.formType} ({match.lastUsed.payerName})</>}
              <div style={{ marginTop: 6 }}>
                <button type="button" className="small" onClick={useMatch}>Confirm / update this recipient</button>
              </div>
            </div>
          )}
          <div className="row">
            <div className="field grow"><label>Name</label><input value={form.name1} onChange={set('name1')} required /></div>
            <div className="field grow"><label>Name line 2</label><input value={form.name2} onChange={set('name2')} /></div>
          </div>
          <div className="row">
            <div className="field grow"><label>Address line 1</label><input value={form.line1} onChange={set('line1')} required /></div>
            <div className="field grow"><label>Line 2</label><input value={form.line2} onChange={set('line2')} /></div>
          </div>
          <div className="row">
            <div className="field grow"><label>City</label><input value={form.city} onChange={set('city')} required /></div>
            <div className="field" style={{ maxWidth: 70 }}><label>State</label><input value={form.state} onChange={set('state')} maxLength={2} required /></div>
            <div className="field" style={{ maxWidth: 120 }}><label>ZIP</label><input value={form.zip} onChange={set('zip')} required /></div>
          </div>
          <div className="row">
            <div className="field grow"><label>Email</label><input value={form.email} onChange={set('email')} type="email" /></div>
            <div className="field grow"><label>Mobile</label><input value={form.mobile} onChange={set('mobile')} /></div>
          </div>
          <button type="submit">{editing ? 'Save changes' : 'Add to vault'}</button>
        </form>
      )}

      <div className="panel">
        <div className="row">
          <div className="field grow"><label>Search (name or last-4)</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} /></div>
          <div className="field"><label>Filter</label>
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="all">All</option>
              <option value="missing_address">Missing address</option>
              <option value="missing_contact">No email/mobile</option>
              <option value="missing_w9">No W-9</option>
              <option value="stale_w9">Stale W-9</option>
              <option value="backup_wh">Backup withholding</option>
            </select></div>
          <button className="secondary" onClick={load}>Search</button>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <div className="field"><label>Merge duplicate (loser id)</label><input value={mergeFrom} onChange={(e) => setMergeFrom(e.target.value)} placeholder="uuid" /></div>
          <div className="field"><label>into survivor (winner id)</label><input value={mergeTo} onChange={(e) => setMergeTo(e.target.value)} placeholder="uuid" /></div>
          <button className="danger" onClick={merge}>Merge</button>
        </div>
      </div>

      {history && (
        <div className="panel">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Name/address history</h2>
            <button className="small secondary" onClick={() => setHistory(null)}>Close</button>
          </div>
          <table className="grid" style={{ marginTop: 8 }}>
            <thead><tr><th>When</th><th>Name</th><th>Address</th><th>Source</th></tr></thead>
            <tbody>
              {history.map((hst, i) => (
                <tr key={i}>
                  <td>{new Date(hst.createdAt).toLocaleString()}</td>
                  <td>{hst.name1}</td>
                  <td>{hst.address['line1']}, {hst.address['city']}, {hst.address['state']}</td>
                  <td>{hst.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <table className="grid">
        <thead><tr><th>Name</th><th>TIN</th><th>City</th><th>Contact</th><th>W-9</th><th>ID</th><th></th></tr></thead>
        <tbody>
          {recipients.map((r) => (
            <tr key={r.id}>
              <td>{r.name1}{r.isItin && <span className="badge warn" style={{ marginLeft: 6 }}>ITIN</span>}
                {r.backupWithholding && <span className="badge err" style={{ marginLeft: 6 }}>BWH</span>}</td>
              <td className="mono">{r.tinMasked} <button className="small secondary" onClick={() => revealTin(r.id)}>reveal</button></td>
              <td>{r.address['city']}, {r.address['state']}</td>
              <td>{r.email ?? r.mobile ?? <span className="badge warn">paper-only</span>}</td>
              <td><span className={`badge ${r.w9Status === 'on_file' ? 'ok' : r.w9Status === 'none' ? 'err' : 'warn'}`}>{r.w9Status}</span>
                {r.w9Status !== 'on_file' && <button className="small secondary" style={{ marginLeft: 4 }} onClick={() => requestW9(r)}>request</button>}</td>
              <td className="mono muted" style={{ fontSize: 10 }}>{r.id.slice(0, 8)}…</td>
              <td>
                <button className="small secondary" onClick={() => { setEditing(r.id); setShowForm(true); setMatch(null); setForm({
                  tin: '', tinType: r.tinType, name1: r.name1, name2: r.name2,
                  line1: r.address['line1'] ?? '', line2: r.address['line2'] ?? '', city: r.address['city'] ?? '',
                  state: r.address['state'] ?? 'MO', zip: r.address['zip'] ?? '',
                  email: r.email ?? '', mobile: r.mobile ?? '', backupWithholding: r.backupWithholding,
                }); }}>Edit</button>
                <button className="small secondary" onClick={() => showHistory(r.id)}>History</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
