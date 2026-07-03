/**
 * Control tower (Phase C) — answers "what needs me across 100 entities":
 * roll-up totals, sortable/filterable per-payer progress with deadline risk,
 * saved views, and a link into the Work Inbox.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useDialogs } from '../components/Dialogs';
import { useTaxYears } from '../components/useTaxYears';

interface SavedView { id: string; name: string; config: { sort?: string; dir?: number; filter?: string; search?: string } }

const CURRENT_TY = 2026;

interface Progress {
  payerId: string;
  payerName: string;
  total: number;
  entered: number;
  ready: number;
  transmitted: number;
  accepted: number;
  rejected: number;
  delivered: number;
}

type SortKey = 'payerName' | 'total' | 'ready' | 'accepted' | 'rejected' | 'delivered' | 'unfiled';
type FilterKey = 'all' | 'rejects' | 'unfiled' | 'undelivered';

export function Dashboard() {
  const [taxYear, setTaxYear] = useState(CURRENT_TY);
  const { years: taxYears, current: currentYear } = useTaxYears();
  useEffect(() => { setTaxYear(currentYear); }, [currentYear]);
  const [season, setSeason] = useState<{ progress: Progress[]; deadlines: Record<string, string>; yearLocked: boolean } | null>(null);
  const [deadlines, setDeadlines] = useState<{ deadlines: Record<string, { date: string; note: string }>; counts: Record<string, number> } | null>(null);
  const [inbox, setInbox] = useState<{ total: number; counts: Record<string, number> } | null>(null);
  const [vault, setVault] = useState<Record<string, number> | null>(null);
  const [sort, setSort] = useState<SortKey>('unfiled');
  const [dir, setDir] = useState<1 | -1>(-1);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [search, setSearch] = useState('');
  const [views, setViews] = useState<SavedView[]>([]);
  const dialogs = useDialogs();

  const loadViews = () => api.get<{ views: SavedView[] }>('/api/views/dashboard').then((r) => setViews(r.views)).catch(() => {});
  useEffect(() => { void loadViews(); }, []);

  const applyView = (v: SavedView) => {
    if (v.config.sort) setSort(v.config.sort as SortKey);
    if (v.config.dir) setDir(v.config.dir as 1 | -1);
    if (v.config.filter) setFilter(v.config.filter as FilterKey);
    setSearch(v.config.search ?? '');
  };
  const saveView = async () => {
    const name = await dialogs.prompt('Name this view:', { title: 'Save dashboard view' });
    if (!name) return;
    await api.post('/api/views', { screen: 'dashboard', name, config: { sort, dir, filter, search } });
    dialogs.toast('View saved.', 'success');
    loadViews();
  };
  const deleteView = async (id: string) => { await api.del(`/api/views/${id}`); loadViews(); };

  useEffect(() => {
    api.get<{ progress: Progress[]; deadlines: Record<string, string>; yearLocked: boolean }>(`/api/dashboard/season/${taxYear}`).then(setSeason).catch(() => {});
    api.get<{ deadlines: Record<string, { date: string; note: string }>; counts: Record<string, number> }>(`/api/iris/deadlines/${taxYear}`).then(setDeadlines).catch(() => {});
    api.get<{ total: number; counts: Record<string, number> }>(`/api/inbox/${taxYear}?limit=1`).then(setInbox).catch(() => {});
    api.get<{ stats: Record<string, number> }>('/api/recipients/stats').then((r) => setVault(r.stats)).catch(() => {});
  }, [taxYear]);

  const daysUntil = (date: string) => Math.ceil((new Date(date + 'T23:59:59').getTime() - Date.now()) / 86_400_000);
  const unfiledOf = (p: Progress) => p.entered + p.ready; // draft+ready+queued not yet transmitted

  const rows = useMemo(() => {
    let list = season?.progress ?? [];
    if (search) list = list.filter((p) => p.payerName.toLowerCase().includes(search.toLowerCase()));
    if (filter === 'rejects') list = list.filter((p) => p.rejected > 0);
    if (filter === 'unfiled') list = list.filter((p) => unfiledOf(p) > 0);
    if (filter === 'undelivered') list = list.filter((p) => p.accepted > p.delivered);
    const val = (p: Progress): number | string =>
      sort === 'payerName' ? p.payerName : sort === 'unfiled' ? unfiledOf(p) : (p[sort] as number);
    return [...list].sort((a, b) => {
      const av = val(a), bv = val(b);
      return (typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number)) * dir;
    });
  }, [season, search, filter, sort, dir]);

  const rollup = useMemo(() => {
    const p = season?.progress ?? [];
    return {
      payers: p.length,
      total: p.reduce((n, x) => n + x.total, 0),
      unfiled: p.reduce((n, x) => n + unfiledOf(x), 0),
      accepted: p.reduce((n, x) => n + x.accepted, 0),
      rejected: p.reduce((n, x) => n + x.rejected, 0),
      delivered: p.reduce((n, x) => n + x.delivered, 0),
    };
  }, [season]);

  const sortBy = (k: SortKey) => { if (sort === k) setDir((d) => (d === 1 ? -1 : 1)); else { setSort(k); setDir(-1); } };
  const Th = ({ k, label }: { k: SortKey; label: string }) => (
    <th className="num" style={{ cursor: 'pointer' }} onClick={() => sortBy(k)}>{label}{sort === k ? (dir === 1 ? ' ▲' : ' ▼') : ''}</th>
  );

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Season dashboard — TY{taxYear}</h1>
        <div className="field" style={{ minWidth: 100 }}>
          <label>Tax year</label>
          <select value={taxYear} onChange={(e) => setTaxYear(Number(e.target.value))}>{taxYears.map((y) => <option key={y} value={y}>{y}</option>)}</select>
        </div>
      </div>

      {season?.yearLocked && <div className="warn-box">Tax year {taxYear} is locked (read-only except corrections).</div>}

      {/* roll-up header */}
      <div className="stat-row">
        <div className="stat"><div className="n">{rollup.payers}</div><div className="l">Payers</div></div>
        <div className="stat"><div className="n">{rollup.total.toLocaleString()}</div><div className="l">Forms total</div></div>
        <div className="stat"><div className="n" style={{ color: rollup.unfiled ? 'var(--warn)' : 'var(--ok)' }}>{rollup.unfiled.toLocaleString()}</div><div className="l">Unfiled</div></div>
        <div className="stat"><div className="n" style={{ color: 'var(--ok)' }}>{rollup.accepted.toLocaleString()}</div><div className="l">Accepted</div></div>
        <div className="stat"><div className="n" style={{ color: rollup.rejected ? 'var(--danger)' : undefined }}>{rollup.rejected}</div><div className="l">Rejected</div></div>
        {inbox && <Link to="/inbox" className="stat" style={{ textDecoration: 'none' }}><div className="n" style={{ color: inbox.total ? 'var(--warn)' : 'var(--ok)' }}>{inbox.total}</div><div className="l">Work inbox →</div></Link>}
      </div>

      {deadlines && (
        <div className="panel" style={{ padding: '8px 14px', marginTop: 6 }}>
          <div className="row" style={{ gap: 20, alignItems: 'center' }}>
            <span className="group-label">Deadlines</span>
            {Object.entries(deadlines.deadlines).map(([key, d]) => {
              const dd = daysUntil(d.date);
              const label = key === 'recipientFurnish' ? 'Recipient copies' : key === 'irsEfile' ? 'IRS e-file' : 'Missouri';
              return (
                <span key={key} title={d.note}>
                  {label}: <strong style={{ color: dd < 14 ? 'var(--danger)' : dd < 30 ? 'var(--warn)' : 'var(--ok)' }}>{dd >= 0 ? `${dd}d` : 'past'}</strong>{' '}
                  <span className="muted">({d.date})</span>
                </span>
              );
            })}
            {vault && <span className="muted" style={{ marginLeft: 'auto' }}>Vault {vault['total'] ?? 0} · {vault['w9Missing'] ?? 0} no W-9</span>}
          </div>
        </div>
      )}

      <div className="row" style={{ margin: '12px 0 6px', alignItems: 'flex-end' }}>
        <h2 style={{ margin: 0 }}>Progress by payer</h2>
        <div className="grow" />
        <div className="field" style={{ minWidth: 160 }}><label>Search</label><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Payer name…" /></div>
        <div className="tabs" style={{ margin: 0 }}>
          {(['all', 'unfiled', 'rejects', 'undelivered'] as FilterKey[]).map((f) => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>{f}</button>
          ))}
        </div>
      </div>

      <div className="row" style={{ gap: 6, alignItems: 'center', margin: '4px 0 8px' }}>
        <span className="group-label">Saved views</span>
        {views.map((v) => (
          <span key={v.id} className="badge" style={{ cursor: 'pointer', background: '#eef2ff', color: 'var(--accent-dark)' }} onClick={() => applyView(v)}>
            {v.name} <span onClick={(e) => { e.stopPropagation(); deleteView(v.id); }} style={{ marginLeft: 4, color: 'var(--muted)' }}>✕</span>
          </span>
        ))}
        <button className="small secondary" onClick={saveView}>+ Save current view</button>
      </div>

      <table className="grid">
        <thead>
          <tr>
            <th style={{ cursor: 'pointer' }} onClick={() => sortBy('payerName')}>Payer{sort === 'payerName' ? (dir === 1 ? ' ▲' : ' ▼') : ''}</th>
            <Th k="total" label="Total" /><Th k="unfiled" label="Unfiled" /><Th k="ready" label="Ready" />
            <th className="num">Transmitted</th><Th k="accepted" label="Accepted" /><Th k="rejected" label="Rejected" /><Th k="delivered" label="Delivered" />
            <th>Risk</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const furnishDays = deadlines ? daysUntil(deadlines.deadlines['recipientFurnish']?.date ?? '') : 99;
            const atRisk = unfiledOf(p) > 0 && furnishDays < 14;
            return (
              <tr key={p.payerId}>
                <td><Link to={`/forms?payerId=${p.payerId}&taxYear=${taxYear}`}>{p.payerName}</Link></td>
                <td className="num">{p.total}</td>
                <td className="num" style={{ color: unfiledOf(p) ? 'var(--warn)' : undefined }}>{unfiledOf(p)}</td>
                <td className="num">{p.ready}</td>
                <td className="num">{p.transmitted}</td>
                <td className="num" style={{ color: 'var(--ok)' }}>{p.accepted}</td>
                <td className="num" style={{ color: p.rejected ? 'var(--danger)' : undefined }}>{p.rejected}</td>
                <td className="num">{p.delivered}</td>
                <td>{p.rejected > 0 ? <span className="badge err">rejects</span> : atRisk ? <span className="badge warn">deadline</span> : p.accepted > p.delivered ? <span className="badge warn">deliver</span> : <span className="badge ok">ok</span>}</td>
              </tr>
            );
          })}
          {!rows.length && <tr><td colSpan={9} className="muted">No payers match this filter.</td></tr>}
        </tbody>
      </table>
      <p className="muted">Work the <Link to="/inbox">inbox</Link> to clear exceptions, and use <Link to="/fleet">fleet operations</Link> to transmit/deliver across all payers at once.</p>
    </div>
  );
}
