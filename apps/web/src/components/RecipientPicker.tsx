/**
 * Vault recipient search + add — replaces the window.prompt() UUID paste in the
 * form grid. Searches the firm vault by name or last-4 and lets staff add a new
 * recipient inline if not found.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface Recip {
  id: string;
  name1: string;
  tinMasked: string;
  address: Record<string, string>;
  w9Status: string;
}

export function RecipientPicker({ onPick, onClose }: { onPick: (recipientId: string, name: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Recip[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return; }
    setLoading(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api
        .get<{ recipients: Recip[] }>(`/api/recipients?search=${encodeURIComponent(q.trim())}&limit=25`)
        .then((r) => setResults(r.recipients))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(timer.current);
  }, [q]);

  return (
    <div className="panel" style={{ position: 'absolute', zIndex: 30, width: 460, boxShadow: '0 6px 20px rgba(0,0,0,0.18)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>Add recipient to grid</strong>
        <button className="small secondary" onClick={onClose}>Close</button>
      </div>
      <input autoFocus placeholder="Search vault by name or last-4 TIN…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginTop: 8 }} />
      {loading && <div className="muted" style={{ marginTop: 6 }}>Searching…</div>}
      <div style={{ maxHeight: 260, overflowY: 'auto', marginTop: 8 }}>
        {results.map((r) => (
          <div key={r.id} className="combo-opt" onClick={() => onPick(r.id, r.name1)}
            style={{ padding: '6px 8px', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}>
            <strong>{r.name1}</strong> <span className="mono muted">{r.tinMasked}</span>
            <div className="muted" style={{ fontSize: 11 }}>{r.address['city']}, {r.address['state']} · W-9 {r.w9Status}</div>
          </div>
        ))}
        {!loading && q.trim().length >= 2 && !results.length && (
          <div className="muted" style={{ padding: 8 }}>
            No vault match. Add the recipient on the Recipients page first, then return here.
          </div>
        )}
      </div>
    </div>
  );
}
