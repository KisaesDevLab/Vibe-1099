import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError } from '../api';

interface Payer {
  id: string;
  legalName: string;
  dbaName: string;
  tinMasked: string;
  tinType: 'SSN' | 'EIN';
  address: Record<string, string>;
  phone: string;
  contactEmail: string | null;
  contactMobile: string | null;
  moWithholdingId: string | null;
  moSourceDefault: boolean;
}

const emptyForm = {
  legalName: '', dbaName: '', tin: '', tinType: 'EIN' as 'SSN' | 'EIN',
  line1: '', line2: '', city: '', state: 'MO', zip: '',
  phone: '', contactEmail: '', contactMobile: '', moWithholdingId: '', moSourceDefault: true,
};

export function Payers() {
  const [payers, setPayers] = useState<Payer[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.get<{ payers: Payer[] }>('/api/payers').then((r) => setPayers(r.payers));
  useEffect(() => { void load(); }, []);

  const set = (k: keyof typeof emptyForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const body = {
      legalName: form.legalName,
      dbaName: form.dbaName,
      ...(form.tin ? { tin: form.tin, tinType: form.tinType } : editing ? {} : { tin: form.tin, tinType: form.tinType }),
      address: { line1: form.line1, line2: form.line2, city: form.city, state: form.state, zip: form.zip },
      phone: form.phone,
      contactEmail: form.contactEmail || null,
      contactMobile: form.contactMobile || null,
      moWithholdingId: form.moWithholdingId || null,
      moSourceDefault: form.moSourceDefault,
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
      legalName: p.legalName, dbaName: p.dbaName, tin: '', tinType: p.tinType,
      line1: p.address['line1'] ?? '', line2: p.address['line2'] ?? '', city: p.address['city'] ?? '',
      state: p.address['state'] ?? 'MO', zip: p.address['zip'] ?? '',
      phone: p.phone, contactEmail: p.contactEmail ?? '', contactMobile: p.contactMobile ?? '',
      moWithholdingId: p.moWithholdingId ?? '', moSourceDefault: p.moSourceDefault,
    });
  };

  const revealTin = async (id: string) => {
    const r = await api.post<{ tin: string }>(`/api/payers/${id}/reveal-tin`);
    alert(`Payer TIN: ${r.tin}\n(reveal recorded in the audit log)`);
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Payers</h1>
        <button onClick={() => { setShowForm(!showForm); setEditing(null); setForm(emptyForm); }}>
          {showForm ? 'Cancel' : '+ Add payer'}
        </button>
      </div>
      {error && <div className="error-box">{error}</div>}

      {showForm && (
        <form className="panel" onSubmit={submit}>
          <div className="row">
            <div className="field grow"><label>Legal name</label><input value={form.legalName} onChange={set('legalName')} required /></div>
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
        <thead><tr><th>Legal name</th><th>TIN</th><th>City</th><th>MO WH ID</th><th>Contact</th><th></th></tr></thead>
        <tbody>
          {payers.map((p) => (
            <tr key={p.id}>
              <td>{p.legalName}{p.dbaName && <span className="muted"> dba {p.dbaName}</span>}</td>
              <td className="mono">{p.tinMasked} <button className="small secondary" onClick={() => revealTin(p.id)}>reveal</button></td>
              <td>{p.address['city']}, {p.address['state']}</td>
              <td>{p.moWithholdingId ?? <span className="muted">—</span>}</td>
              <td>{p.contactEmail ?? p.contactMobile ?? <span className="muted">—</span>}</td>
              <td><button className="small secondary" onClick={() => edit(p)}>Edit</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
