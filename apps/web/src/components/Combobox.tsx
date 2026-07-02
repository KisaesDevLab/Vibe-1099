/**
 * Searchable single-select combobox — replaces 100-option <select>s so a firm
 * with 100 payers can type-to-find instead of scrolling a dropdown.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

export interface Option {
  value: string;
  label: string;
  sub?: string;
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder = 'Search…',
  allowEmpty,
}: {
  options: Option[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  allowEmpty?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? options.filter((o) => o.label.toLowerCase().includes(q) || (o.sub ?? '').toLowerCase().includes(q))
      : options;
    return list.slice(0, 50);
  }, [options, query]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <input
        value={open ? query : selected?.label ?? ''}
        placeholder={selected ? selected.label : placeholder}
        onFocus={() => { setOpen(true); setQuery(''); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
      />
      {open && (
        <div
          style={{
            position: 'absolute', zIndex: 20, top: '100%', left: 0, right: 0, maxHeight: 280, overflowY: 'auto',
            background: '#fff', border: '1px solid var(--border)', borderRadius: 6, marginTop: 2, boxShadow: '0 4px 14px rgba(0,0,0,0.12)',
          }}
        >
          {allowEmpty && (
            <div className="combo-opt" onMouseDown={() => { onChange(''); setOpen(false); }}
              style={{ padding: '6px 10px', cursor: 'pointer', color: 'var(--muted)' }}>— none —</div>
          )}
          {filtered.map((o) => (
            <div key={o.value} className="combo-opt"
              onMouseDown={() => { onChange(o.value); setOpen(false); }}
              style={{ padding: '6px 10px', cursor: 'pointer', background: o.value === value ? '#eef2ff' : undefined }}>
              {o.label}{o.sub && <span className="muted" style={{ marginLeft: 6 }}>{o.sub}</span>}
            </div>
          ))}
          {!filtered.length && <div style={{ padding: '6px 10px' }} className="muted">No matches</div>}
          {options.length > 50 && query === '' && (
            <div style={{ padding: '6px 10px' }} className="muted">Type to search {options.length.toLocaleString()} items…</div>
          )}
        </div>
      )}
    </div>
  );
}
