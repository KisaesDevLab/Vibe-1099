/**
 * Work Inbox (Phase B) — the unified "what needs me" queue across all payers,
 * paginated and filterable, with one-click resolution jumps and bulk W-9.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTaxYears } from '../components/useTaxYears';
import { useSort } from '../components/useSort';
import { api } from '../api';
import { Paginator, usePageSize } from '../components/Paginator';
import { usePreparerFilter } from '../components/PreparerFilter';

interface Item {
  kind: 'review' | 'rejected' | 'missing_w9' | 'missing_address';
  formRecordId?: string;
  recipientId?: string;
  payerId?: string;
  title: string;
  detail: string;
}
const KINDS = [
  { key: 'rejected', label: 'Rejected', badge: 'err' },
  { key: 'review', label: 'Client reviews', badge: 'warn' },
  { key: 'missing_w9', label: 'Missing W-9', badge: 'warn' },
  { key: 'missing_address', label: 'Missing address', badge: 'warn' },
] as const;

export function Inbox() {
  const [taxYear, setTaxYear] = useState(2026);
  const { years: taxYears, current: currentYear } = useTaxYears();
  useEffect(() => { setTaxYear(currentYear); }, [currentYear]);
  const [items, setItems] = useState<Item[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const navigate = useNavigate();
  const [limit, setLimit] = usePageSize('inbox', 100);
  const preparers = usePreparerFilter();

  const load = (off = 0) => {
    const kinds = filter.length ? `&kinds=${filter.join(',')}` : '';
    return api
      .get<{ items: Item[]; total: number; counts: Record<string, number> }>(`/api/inbox/${taxYear}?limit=${limit}&offset=${off}${kinds}${preparers.query}`)
      .then((r) => { setItems(r.items); setTotal(r.total); setCounts(r.counts); setOffset(off); });
  };
  useEffect(() => { void load(0); }, [taxYear, filter, limit, preparers.query]);

  const toggle = (k: string) => setFilter((f) => (f.includes(k) ? f.filter((x) => x !== k) : [...f, k]));

  const w9Campaign = async () => {
    const r = await api.post<{ requested: number }>('/api/w9/campaign', {});
    setNotice(`W-9 campaign sent to ${r.requested} recipient(s).`);
    load(offset);
  };

  const go = (it: Item) => {
    if (it.kind === 'rejected' && it.payerId) navigate(`/forms?payerId=${it.payerId}&taxYear=${taxYear}`);
    else if (it.kind === 'review') navigate('/review');
    else navigate('/recipients');
  };


  const sort = useSort(items, {
    kind: (it) => it.kind,
    item: (it) => it.title,
    detail: (it) => it.detail,
  });

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Work inbox</h1>
        <div className="field" style={{ minWidth: 100 }}><label>Tax year</label>
          <select value={taxYear} onChange={(e) => setTaxYear(Number(e.target.value))}>{taxYears.map((y) => <option key={y} value={y}>{y}</option>)}</select></div>
      </div>
      {notice && <div className="ok-box">{notice}</div>}

      <div className="stat-row">
        {KINDS.map((k) => (
          <div key={k.key} className="stat" style={{ cursor: 'pointer', outline: filter.includes(k.key) ? '2px solid var(--accent)' : undefined }} onClick={() => toggle(k.key)}>
            <div className="n">{counts[k.key] ?? 0}</div>
            <div className="l">{k.label}</div>
          </div>
        ))}
      </div>

      <div className="row" style={{ margin: '8px 0' }}>
        <span className="muted">{filter.length ? `Filtered: ${filter.join(', ')}` : 'Showing all kinds'}</span>
        {filter.length > 0 && <button className="small secondary" onClick={() => setFilter([])}>Clear filter</button>}
        <button className="small secondary" onClick={w9Campaign}>Bulk-request all missing W-9</button>
      </div>

      <table className="grid">
        <thead><tr>{sort.th('kind', 'Kind')}{sort.th('item', 'Item')}{sort.th('detail', 'Detail')}<th></th></tr></thead>
        <tbody>
          {sort.rows.map((it, i) => (
            <tr key={i}>
              <td><span className={`badge ${KINDS.find((k) => k.key === it.kind)?.badge ?? 'warn'}`}>{it.kind.replace('_', ' ')}</span></td>
              <td>{it.title}</td>
              <td className="muted">{it.detail}</td>
              <td><button className="small" onClick={() => go(it)}>Resolve →</button></td>
            </tr>
          ))}
          {!items.length && <tr><td colSpan={4} className="muted">Nothing needs attention. Clean queue.</td></tr>}
        </tbody>
      </table>
      <Paginator total={total} limit={limit} offset={offset} onChange={(o) => load(o)} onLimitChange={setLimit} unit="items" />
      <p className="muted"><Link to="/">Back to dashboard</Link></p>
    </div>
  );
}
