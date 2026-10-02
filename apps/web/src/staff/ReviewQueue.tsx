import { Fragment, useEffect, useMemo, useState } from 'react';
import { api, ApiError, formatCents } from '../api';
import { ALL_ROWS, Paginator, usePageSize } from '../components/Paginator';
import { usePreparerFilter } from '../components/PreparerFilter';
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
  recipient: Recipient | null;
  isNewRecipient: boolean;
  priorYears: number[];
  duplicates: Array<{ id: string; status: string; clientSubmitted: boolean; boxValues: Record<string, number | boolean | string | null> }>;
}
interface Recipient {
  id: string;
  name1: string;
  name2: string;
  tinMasked: string;
  tinType: string;
  isItin: boolean;
  address: Record<string, string>;
  email: string | null;
  mobile: string | null;
  w9Status: string;
  backupWithholding: boolean;
  createdFrom: string;
  createdAt: string;
}
interface Payer { id: string; legalName: string }

export function ReviewQueue() {
  const dialogs = useDialogs();
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [payers, setPayers] = useState<Record<string, string>>({});
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  // default All: paging splits an engagement's rows across pages
  const [limit, setLimit] = usePageSize('review-queue', ALL_ROWS);
  const preparers = usePreparerFilter();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const load = (off = 0) =>
    api.get<{ queue: QueueRow[]; total: number }>(`/api/invites/review-queue?limit=${limit}&offset=${off}${preparers.query}`)
      .then((r) => { setQueue(r.queue); setTotal(r.total); setOffset(off); });
  useEffect(() => { void load(0); }, [limit, preparers.query]);
  useEffect(() => {
    api.get<{ payers: Payer[] }>('/api/payers?limit=1000').then((r) => setPayers(Object.fromEntries(r.payers.map((p) => [p.id, p.legalName]))));
  }, []);

  // group the queue by payer so staff review whole engagements, not rows
  const groups = useMemo(() => {
    const m = new Map<string, QueueRow[]>();
    for (const r of queue) { const g = m.get(r.payerId) ?? []; g.push(r); m.set(r.payerId, g); }
    return [...m.entries()];
  }, [queue]);

  const promoteOne = async (id: string) => {
    try { await api.post(`/api/invites/review-queue/${id}/promote`); }
    catch (err) { dialogs.toast(err instanceof ApiError ? err.message : String(err), 'error'); }
    load(offset);
  };
  const discard = async (q: QueueRow) => {
    if (!(await dialogs.confirm(`Delete this client-submitted 1099-${q.formType} for ${q.recipient?.name1 ?? 'this recipient'}?`, { title: 'Discard submission', danger: true }))) return;
    await api.del(`/api/forms/${q.id}`).catch((err: ApiError) => dialogs.toast(err.message, 'error'));
    load(offset);
  };
  const promotePayer = async (payerId: string, taxYear: number, n: number) => {
    if (!(await dialogs.confirm(`Accept all ${n} client-submitted form(s) from ${payers[payerId] ?? 'this payer'}? They move to "ready".`, { title: 'Accept engagement' }))) return;
    const r = await api.post<{ promoted: number; failed: Array<{ reason: string }> }>('/api/invites/review-queue/promote-payer', { payerId, taxYear });
    dialogs.toast(
      r.failed.length ? `Promoted ${r.promoted}; ${r.failed.length} held back — ${r.failed[0]!.reason}` : `Promoted ${r.promoted} form(s) to ready.`,
      r.failed.length ? 'error' : 'success',
    );
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
            <thead><tr><th>Recipient</th><th>Form</th><th>Amounts</th><th>Submitted</th><th></th></tr></thead>
            <tbody>
              {rows.map((q) => {
                const r = q.recipient;
                const filedDup = q.duplicates.find((d) => d.status !== 'draft');
                return (
                  <Fragment key={q.id}>
                    <tr>
                      <td>
                        <a style={{ cursor: 'pointer' }} onClick={() => toggle(q.id)}>{open.has(q.id) ? '▾' : '▸'} {r ? r.name1 : q.recipientId.slice(0, 8)}</a>
                        {r && <span className="muted" style={{ marginLeft: 6, fontFamily: 'monospace' }}>{r.tinMasked}</span>}
                        {q.isNewRecipient && <span className="badge warn" style={{ marginLeft: 6 }} title="No prior-year form and nothing staff-entered for this payer">new</span>}
                        {r?.createdFrom === 'client' && <span className="badge draft" style={{ marginLeft: 6 }} title="Added to the vault by the client">client-added</span>}
                        {r && r.w9Status !== 'on_file' && <span className="badge rejected" style={{ marginLeft: 6 }}>W-9 {r.w9Status === 'none' ? 'missing' : r.w9Status}</span>}
                        {filedDup && <div><span className="badge rejected" style={{ marginTop: 4 }}>duplicate — already {filedDup.status}: {money(filedDup.boxValues) || 'no amounts'}</span></div>}
                        {!filedDup && q.duplicates.length > 0 && <div><span className="badge warn" style={{ marginTop: 4 }}>{q.duplicates.length} other draft(s) for this recipient</span></div>}
                      </td>
                      <td>1099-{q.formType}</td>
                      <td>{money(q.boxValues)}</td>
                      <td>{new Date(q.updatedAt).toLocaleString()}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="small secondary" disabled={!!filedDup} title={filedDup ? 'A form for this recipient is already past draft' : ''} onClick={() => promoteOne(q.id)}>Accept</button>{' '}
                        <button className="small danger" onClick={() => discard(q)}>Discard</button>
                      </td>
                    </tr>
                    {open.has(q.id) && (
                      <tr>
                        <td colSpan={5} style={{ background: '#f8fafc' }}>
                          {r ? (
                            <div className="row" style={{ gap: 32, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                              <div>
                                <div className="muted">Name</div>
                                <div>{r.name1}</div>
                                {r.name2 && <div>{r.name2}</div>}
                              </div>
                              <div>
                                <div className="muted">Mailing address (Copy B)</div>
                                <div>{r.address['line1'] || <em className="muted">missing</em>}</div>
                                {r.address['line2'] && <div>{r.address['line2']}</div>}
                                <div>{[r.address['city'], r.address['state']].filter(Boolean).join(', ')} {r.address['zip']}</div>
                              </div>
                              <div>
                                <div className="muted">TIN</div>
                                <div style={{ fontFamily: 'monospace' }}>{r.tinMasked} <span className="muted">({r.isItin ? 'ITIN' : r.tinType})</span></div>
                                {r.backupWithholding && <span className="badge warn">backup withholding</span>}
                              </div>
                              <div>
                                <div className="muted">Contact</div>
                                <div>{r.email || <span className="muted">no email</span>}</div>
                                <div>{r.mobile || <span className="muted">no mobile</span>}</div>
                              </div>
                              <div>
                                <div className="muted">History with this payer</div>
                                <div>{q.priorYears.length ? `Filed TY${q.priorYears.join(', TY')}` : 'None — first year'}</div>
                                <div className="muted">In vault since {new Date(r.createdAt).toLocaleDateString()} ({r.createdFrom})</div>
                              </div>
                            </div>
                          ) : <span className="muted">Recipient not found in vault.</span>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
      {!queue.length && <div className="panel muted">Nothing waiting for review.</div>}
      <Paginator total={total} limit={limit} offset={offset} onChange={(o) => load(o)} onLimitChange={setLimit} unit="submitted forms" />
    </div>
  );
}
