/**
 * Searchable multi-select with select-all/none — replaces the 100-checkbox
 * "payer wall" in Batches / Deliveries / MO / bulk actions.
 */
import { useMemo, useState } from 'react';
import type { Option } from './Combobox';

export function MultiSelect({
  options,
  selected,
  onChange,
  unit = 'items',
}: {
  options: Option[];
  selected: string[];
  onChange: (v: string[]) => void;
  unit?: string;
}) {
  const [query, setQuery] = useState('');
  const sel = new Set(selected);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q) || (o.sub ?? '').toLowerCase().includes(q)) : options;
  }, [options, query]);

  const toggle = (v: string) => onChange(sel.has(v) ? selected.filter((x) => x !== v) : [...selected, v]);

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 8, background: '#fff' }}>
      <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <input style={{ flex: 1 }} placeholder={`Search ${options.length.toLocaleString()} ${unit}…`} value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" className="small secondary" onClick={() => onChange(options.map((o) => o.value))}>All</button>
        <button type="button" className="small secondary" onClick={() => onChange([])}>None</button>
        <button type="button" className="small secondary" onClick={() => onChange(filtered.map((o) => o.value))} disabled={!query}>Matches</button>
        <span className="muted">{selected.length} selected</span>
      </div>
      <div style={{ maxHeight: 200, overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 2 }}>
        {filtered.slice(0, 300).map((o) => (
          <label key={o.value} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, color: 'var(--text)', padding: '2px 4px', cursor: 'pointer' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={sel.has(o.value)} onChange={() => toggle(o.value)} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
          </label>
        ))}
      </div>
      {filtered.length > 300 && <div className="muted" style={{ marginTop: 4 }}>Showing first 300 — refine your search.</div>}
    </div>
  );
}
