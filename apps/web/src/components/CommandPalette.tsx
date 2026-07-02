/**
 * Command palette (Phase C) — Ctrl/Cmd-K global search: jump to any payer or
 * recipient across 100 entities without scrolling a dropdown.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

interface Result { type: 'payer' | 'recipient'; id: string; label: string; sub?: string; link: string }

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); }
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 0); else { setQ(''); setResults([]); } }, [open]);

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return; }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api.get<{ results: Result[] }>(`/api/search?q=${encodeURIComponent(q.trim())}`).then((r) => { setResults(r.results); setActive(0); }).catch(() => {});
    }, 150);
    return () => clearTimeout(timer.current);
  }, [q]);

  const pick = (r: Result) => { setOpen(false); navigate(r.link); };

  if (!open) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 100, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '12vh' }} onMouseDown={() => setOpen(false)}>
      <div style={{ width: 560, background: '#fff', borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.3)', overflow: 'hidden' }} onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            if (e.key === 'Enter' && results[active]) pick(results[active]!);
          }}
          placeholder="Search payers & recipients…  (Ctrl/⌘-K)"
          style={{ width: '100%', border: 'none', borderBottom: '1px solid var(--border)', padding: '14px 16px', fontSize: 15, outline: 'none' }}
        />
        <div style={{ maxHeight: 360, overflowY: 'auto' }}>
          {results.map((r, i) => (
            <div key={r.type + r.id} onMouseEnter={() => setActive(i)} onClick={() => pick(r)}
              style={{ padding: '10px 16px', cursor: 'pointer', background: i === active ? '#eef2ff' : undefined, display: 'flex', justifyContent: 'space-between' }}>
              <span><span className="badge" style={{ marginRight: 8 }}>{r.type}</span>{r.label}</span>
              {r.sub && <span className="mono muted">{r.sub}</span>}
            </div>
          ))}
          {q.trim().length >= 2 && !results.length && <div className="muted" style={{ padding: 16 }}>No matches.</div>}
          {q.trim().length < 2 && <div className="muted" style={{ padding: 16 }}>Type at least 2 characters. ↑↓ to navigate, Enter to open.</div>}
        </div>
      </div>
    </div>
  );
}
