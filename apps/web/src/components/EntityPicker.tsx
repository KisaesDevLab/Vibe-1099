/**
 * EntityPicker — search-to-add basket for bulk operations. Instead of a wall of
 * 100 checkboxes, you type to find a company and click to add it to the working
 * list, remove chips individually, and use state-aware "add all …" buttons
 * (untransmitted, unmailed, undelivered, etc.) to populate the un-processed set
 * in one click.
 */
import { useMemo, useRef, useState } from 'react';
import type { Option } from './Combobox';

export interface QuickAdd { label: string; ids: string[]; title?: string }

export function EntityPicker({
  options,
  selected,
  onChange,
  quickAdds = [],
  unit = 'entities',
}: {
  options: Option[];
  selected: string[];
  onChange: (v: string[]) => void;
  quickAdds?: QuickAdd[];
  unit?: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const byId = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const matches = useMemo(() => {
    const sel = new Set(selected);
    const q = query.trim().toLowerCase();
    return options
      .filter((o) => !sel.has(o.value) && (!q || o.label.toLowerCase().includes(q) || (o.sub ?? '').toLowerCase().includes(q)))
      .slice(0, 30);
  }, [options, query, selected]);

  const add = (id: string) => { onChange([...new Set([...selected, id])]); setQuery(''); };
  const addMany = (ids: string[]) => onChange([...new Set([...selected, ...ids])]);
  const remove = (id: string) => onChange(selected.filter((x) => x !== id));

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 8, background: '#fff' }}>
      {/* state-aware quick-adds */}
      {quickAdds.length > 0 && (
        <div className="row" style={{ gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
          <span className="group-label">Add all</span>
          {quickAdds.map((qa) => (
            <button key={qa.label} type="button" className="small secondary" title={qa.title} disabled={!qa.ids.length}
              onClick={() => addMany(qa.ids)}>{qa.label} ({qa.ids.length})</button>
          ))}
        </div>
      )}

      {/* search-to-add */}
      <div ref={ref} style={{ position: 'relative' }}>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <input
            style={{ flex: 1 }}
            placeholder={`Search to add ${unit}…`}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={(e) => { if (e.key === 'Enter' && matches[0]) { e.preventDefault(); add(matches[0].value); } }}
          />
          <span className="muted">{selected.length} selected</span>
          {selected.length > 0 && <button type="button" className="small secondary" onClick={() => onChange([])}>Clear</button>}
        </div>
        {open && query.trim() !== '' && (
          <div style={{ position: 'absolute', zIndex: 20, top: '100%', left: 0, right: 0, maxHeight: 240, overflowY: 'auto', background: '#fff', border: '1px solid var(--border)', borderRadius: 6, marginTop: 2, boxShadow: '0 4px 14px rgba(0,0,0,0.12)' }}>
            {matches.map((o) => (
              <div key={o.value} className="combo-opt" onMouseDown={() => add(o.value)} style={{ padding: '6px 10px', cursor: 'pointer' }}>
                {o.label}{o.sub && <span className="muted" style={{ marginLeft: 6 }}>{o.sub}</span>}
              </div>
            ))}
            {!matches.length && <div className="muted" style={{ padding: '6px 10px' }}>No matches (or already added).</div>}
          </div>
        )}
      </div>

      {/* selected chips */}
      {selected.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {selected.map((id) => (
            <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#eef2ff', color: 'var(--accent-dark)', borderRadius: 12, padding: '2px 6px 2px 10px', fontSize: 12 }}>
              {byId.get(id)?.label ?? id.slice(0, 8)}
              <span onClick={() => remove(id)} style={{ cursor: 'pointer', fontWeight: 700, padding: '0 2px' }} title="Remove">×</span>
            </span>
          ))}
        </div>
      )}
      {!selected.length && <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>None added yet — search above or use an “add all” button.</div>}
    </div>
  );
}
