import { useEffect, useState } from 'react';
import { api, formatCents } from '../api';

interface QueueRow {
  id: string;
  payerId: string;
  recipientId: string;
  taxYear: number;
  formType: string;
  boxValues: Record<string, number | boolean | string | null>;
  clientInviteId: string | null;
  updatedAt: string;
}

export function ReviewQueue() {
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [notice, setNotice] = useState('');

  const load = () => api.get<{ queue: QueueRow[] }>('/api/invites/review-queue').then((r) => setQueue(r.queue));
  useEffect(() => { void load(); }, []);

  const promote = async (id: string) => {
    await api.post(`/api/invites/review-queue/${id}/promote`);
    setNotice('Promoted to ready.');
    load();
  };

  const money = (bv: Record<string, number | boolean | string | null>) =>
    Object.entries(bv)
      .filter(([, v]) => typeof v === 'number' && (v as number) > 0)
      .map(([k, v]) => `${k}: $${formatCents(v as number)}`)
      .join(', ');

  return (
    <div>
      <h1>Client review queue</h1>
      {notice && <div className="ok-box">{notice}</div>}
      <p className="muted">Client-submitted entries land here as drafts. Review against the vault, adjust in Form entry if needed, then promote to ready.</p>
      <table className="grid">
        <thead><tr><th>Tax year</th><th>Form</th><th>Amounts</th><th>Submitted</th><th></th></tr></thead>
        <tbody>
          {queue.map((q) => (
            <tr key={q.id}>
              <td>{q.taxYear}</td>
              <td>1099-{q.formType}</td>
              <td>{money(q.boxValues)}</td>
              <td>{new Date(q.updatedAt).toLocaleString()}</td>
              <td><button className="small" onClick={() => promote(q.id)}>Accept → ready</button></td>
            </tr>
          ))}
          {!queue.length && <tr><td colSpan={5} className="muted">Nothing waiting for review.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
