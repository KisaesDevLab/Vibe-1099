/**
 * Click-to-sort for table views. Give it the loaded rows and one accessor per
 * sortable column; render headers with `th()` and iterate `rows`.
 *
 * Clicking a header sorts ascending, again descending, a third time restores
 * the original (server) order. Sorting is over the rows currently loaded — on a
 * paged table that is the page in view (pick "All" rows to sort the whole list).
 */
import { useMemo, useState, type ReactNode, type ThHTMLAttributes } from 'react';

type SortValue = string | number | boolean | null | undefined;

const isBlank = (v: SortValue) => v === null || v === undefined || v === '';

function compare(a: SortValue, b: SortValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  // numeric-aware so "Client 9" sorts before "Client 10"
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

export function useSort<T, K extends string>(rows: T[], columns: Record<K, (row: T) => SortValue>) {
  const [key, setKey] = useState<K | null>(null);
  const [dir, setDir] = useState<1 | -1>(1);

  const sorted = useMemo(() => {
    const get = key ? columns[key] : undefined;
    if (!get) return rows;
    return [...rows].sort((ra, rb) => {
      const a = get(ra);
      const b = get(rb);
      // blanks sink to the bottom in either direction
      if (isBlank(a) || isBlank(b)) return Number(isBlank(a)) - Number(isBlank(b));
      return compare(a, b) * dir;
    });
  }, [rows, key, dir]);

  const toggle = (k: K) => {
    if (key !== k) { setKey(k); setDir(1); }
    else if (dir === 1) setDir(-1);
    else setKey(null);
  };

  /** A sortable header cell. Extra props (className="num", style, title…) pass through. */
  const th = (k: K, label: ReactNode, props: ThHTMLAttributes<HTMLTableCellElement> = {}) => (
    <th key={k} {...props} title={props.title ?? 'Click to sort'} style={{ cursor: 'pointer', userSelect: 'none', ...props.style }} onClick={() => toggle(k)}>
      {label}{key === k ? (dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  );

  return { rows: sorted, th };
}
