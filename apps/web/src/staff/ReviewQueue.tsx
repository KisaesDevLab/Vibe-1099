import { useEffect, useMemo, useState } from 'react';
import { api, formatCents } from '../api';
import { Paginator } from '../components/Paginator';
import { useDialogs } from '../components/Dialogs';

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
interface Payer { id: string; legalName: string }

export function ReviewQueue() {
  const dialogs = useDialogs();
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [payers, setPayers] = useState<Record<string, string>>({});
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const LIMIT = 200;

  const load = (off = 0) =>
    api.get<{ queue: QueueRow[]; total: number }>(`/api/invites/review-queue?limit=${LIMIT}&offset=${off}`)
      .then((r) => { setQueue(r.queue); setTotal(r.total); setOffset(off); });
  useEffect(() => {
    void load(0);
    api.get<{ payers: Payer[] }>('/api/payers?limit=1000').then((r) => setPayers(Object.fromEntries(r.payers.map((p) => [p.id, p.legalName]))));
  }, []);

  // group the queue by payer so staff review whole engagements, not rows
  const groups = useMemo(() => {
    const m = new Map<string, QueueRow[]>();
    for (const r of queue) { const g = m.get(r.payerId) ?? []; g.push(r); m.set(r.payerId, g); }
    return [...m.entries()];
  }, [queue]);

  const promoteOne = async (id: string) => { await api.post(`/api/invites/review-queue/${id}/promote`); load(offset); };
  const promotePayer = async (payerId: string, taxYear: number, n: number) => {
    if (!(await dialogs.confirm(`Accept all ${n} client-submitted form(s) from ${payers[payerId] ?? 'this payer'}? They move to "ready".`, { title: 'Accept engagement' }))) return;
    const r = await api.post<{ promoted: number; failed: unknown[] }>('/api/invites/review-queue/promote-payer', { payerId, taxYear });
    dialogs.toast(`Promoted ${r.promoted} form(s) to ready.`, 'success');
    load(offset);
  };

  const money = (bv: Record<string, number | boolean | string | null>) =>
    Object.entries(bv).filter(([, v]) => typeof v === 'number' && (v as number) > 0).map(([k, v]) => `${k}: $${formatCents(v as number)}`).join(', ');

  return (
    <div>
      <h1>Client review queue</h1>
      <p className="muted">Client-submitted entries land here as drafts, grouped by engagement. Review against the vault, then accept the whole engagement or individual rows.</p>
      {groups.map(([payerId, rows]) => (
        <div className="panel" key={payerId}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>{payers[payerId] ?? payerId.slice(0, 8)} <span className="muted" style={{ fontWeight: 400 }}>· {rows.length} form(s), TY{rows[0]!.taxYear}</span></h2>
            <button onClick={() => promotePayer(payerId, rows[0]!.taxYear, rows.length)}>Accept all → ready</button>
          </div>
          <table className="grid" style={{ marginTop: 8 }}>
            <thead><tr><th>Form</th><th>Amounts</th><th>Submitted</th><th></th></tr></thead>
            <tbody>
              {rows.map((q) => (
                <tr key={q.id}>
                  <td>1099-{q.formType}</td>
                  <td>{money(q.boxValues)}</td>
                  <td>{new Date(q.updatedAt).toLocaleString()}</td>
                  <td><button className="small secondary" onClick={() => promoteOne(q.id)}>Accept</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {!queue.length && <div className="panel muted">Nothing waiting for review.</div>}
      <Paginator total={total} limit={LIMIT} offset={offset} onChange={(o) => load(o)} unit="submitted forms" />
    </div>
  );
}
