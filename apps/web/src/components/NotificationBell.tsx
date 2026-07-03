/**
 * Notification bell (Phase B) — visibility-aware polling of async job
 * completions + alerts, so a batch/transmit finishing while you're elsewhere
 * still reaches you.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

interface Note {
  id: string; kind: string; severity: string; title: string; body: string; link: string; readAt: string | null; createdAt: string;
}

export function NotificationBell() {
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const poll = () => {
    if (document.hidden) return; // visibility-aware: don't poll a hidden tab
    api.get<{ count: number }>('/api/notifications/unread-count').then((r) => setCount(r.count)).catch(() => {});
  };
  useEffect(() => {
    poll();
    const t = setInterval(poll, 20_000);
    document.addEventListener('visibilitychange', poll);
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', poll); document.removeEventListener('mousedown', onDoc); };
  }, []);

  const openPanel = async () => {
    setOpen((o) => !o);
    if (!open) {
      const r = await api.get<{ notifications: Note[] }>('/api/notifications');
      setNotes(r.notifications);
    }
  };
  const markAll = async () => {
    await api.post('/api/notifications/read-all');
    setNotes((ns) => ns.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
    setCount(0);
  };
  const clickNote = async (n: Note) => {
    await api.post(`/api/notifications/${n.id}/read`).catch(() => {});
    setNotes((ns) => ns.map((x) => (x.id === n.id ? { ...x, readAt: x.readAt ?? new Date().toISOString() } : x)));
    setOpen(false); poll();
    if (n.link) navigate(n.link);
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="small secondary" onClick={openPanel} title="Notifications">
        🔔{count > 0 && <span style={{ marginLeft: 4, background: 'var(--danger)', color: '#fff', borderRadius: 8, padding: '0 6px', fontSize: 11 }}>{count}</span>}
      </button>
      {open && (
        <div style={{ position: 'absolute', right: 0, top: '100%', width: 340, maxHeight: 420, overflowY: 'auto', background: '#fff', border: '1px solid var(--border)', borderRadius: 8, marginTop: 4, boxShadow: '0 6px 20px rgba(0,0,0,0.18)', zIndex: 40 }}>
          <div className="row" style={{ justifyContent: 'space-between', padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
            <strong>Notifications</strong>
            <button className="small secondary" onClick={markAll}>Mark all read</button>
          </div>
          {notes.map((n) => (
            <div key={n.id} onClick={() => clickNote(n)}
              style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', cursor: 'pointer', background: n.readAt ? undefined : '#f0f7ff' }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>
                <span style={{ marginRight: 6 }}>{n.severity === 'error' ? '⛔' : n.severity === 'warning' ? '⚠️' : n.severity === 'success' ? '✅' : 'ℹ️'}</span>{n.title}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>{n.body}</div>
              <div className="muted" style={{ fontSize: 10 }}>{new Date(n.createdAt).toLocaleString()}</div>
            </div>
          ))}
          {!notes.length && <div className="muted" style={{ padding: 12 }}>No notifications.</div>}
        </div>
      )}
    </div>
  );
}
