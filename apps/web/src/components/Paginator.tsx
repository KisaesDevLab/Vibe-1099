/**
 * Pagination control with an honest total count. Never let a list silently
 * hide rows beyond the first page (the core "never hide data" principle).
 */
import { useCallback, useState } from 'react';

/** "All" page size — the most any list endpoint returns per request. Lists longer
 *  than this still page (and say so), so nothing is ever silently hidden. */
export const ALL_ROWS = 1000;
const PAGE_SIZES = [10, 50, 100, ALL_ROWS];

/** Page size for one table, remembered per browser under `key`. */
export function usePageSize(key: string, fallback: number): [number, (n: number) => void] {
  const storageKey = `v1099.pageSize.${key}`;
  const [limit, setLimitState] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      return PAGE_SIZES.includes(saved) ? saved : fallback;
    } catch { return fallback; }
  });
  const setLimit = useCallback((n: number) => {
    setLimitState(n);
    try { localStorage.setItem(storageKey, String(n)); } catch { /* storage unavailable */ }
  }, [storageKey]);
  return [limit, setLimit];
}

interface Props {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
  /** Provide to show the rows-per-page dropdown (10 / 50 / 100 / All). */
  onLimitChange?: (limit: number) => void;
  unit?: string;
}

export function Paginator({ total, limit, offset, onChange, onLimitChange, unit = 'items' }: Props) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  const canPrev = offset > 0;
  const canNext = to < total;
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
      <span className="muted">
        Showing <strong>{from.toLocaleString()}–{to.toLocaleString()}</strong> of{' '}
        <strong>{total.toLocaleString()}</strong> {unit}
      </span>
      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
        {onLimitChange && (
          <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 4, margin: 0, marginRight: 8 }}>
            Rows
            <select value={limit} onChange={(e) => onLimitChange(Number(e.target.value))} style={{ width: 'auto', padding: '2px 6px' }}>
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n === ALL_ROWS ? 'All' : n}</option>)}
            </select>
          </label>
        )}
        <button className="small secondary" disabled={!canPrev} onClick={() => onChange(0)} title="First">«</button>
        <button className="small secondary" disabled={!canPrev} onClick={() => onChange(Math.max(0, offset - limit))}>‹ Prev</button>
        <span className="muted">Page {page} / {pages}</span>
        <button className="small secondary" disabled={!canNext} onClick={() => onChange(offset + limit)}>Next ›</button>
        <button className="small secondary" disabled={!canNext} onClick={() => onChange((pages - 1) * limit)} title="Last">»</button>
      </div>
    </div>
  );
}
