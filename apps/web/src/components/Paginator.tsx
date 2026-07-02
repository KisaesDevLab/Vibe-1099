/**
 * Pagination control with an honest total count. Never let a list silently
 * hide rows beyond the first page (the core "never hide data" principle).
 */
interface Props {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
  unit?: string;
}

export function Paginator({ total, limit, offset, onChange, unit = 'items' }: Props) {
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
        <button className="small secondary" disabled={!canPrev} onClick={() => onChange(0)} title="First">«</button>
        <button className="small secondary" disabled={!canPrev} onClick={() => onChange(Math.max(0, offset - limit))}>‹ Prev</button>
        <span className="muted">Page {page} / {pages}</span>
        <button className="small secondary" disabled={!canNext} onClick={() => onChange(offset + limit)}>Next ›</button>
        <button className="small secondary" disabled={!canNext} onClick={() => onChange((pages - 1) * limit)} title="Last">»</button>
      </div>
    </div>
  );
}
