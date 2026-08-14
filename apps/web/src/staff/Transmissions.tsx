import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, ApiError, downloadBlob } from '../api';
import { useDialogs } from '../components/Dialogs';
import type { Me } from './Shell';

interface StatusCheck {
  id: string;
  derived: string;
  terminal: boolean;
  applying: boolean;
  errors: Array<{ recordId?: string; code?: string; message?: string }>;
  records?: Array<{ recordId: string; status: string; scheduledOn?: string }>;
  scheduledOn?: string | null;
  raw: string;
  error?: string;
}

interface Tx {
  id: string;
  payerName: string | null;
  taxYear: number;
  environment: 'ATS' | 'PROD';
  utid: string;
  receiptId: string | null;
  status: string;
  isCorrection: boolean;
  recordCount: number;
  provider: 'iris' | 'tax1099' | 'taxbandits';
  /** null = unknown (filed before state history was recorded); [] = none filed. */
  statesFiled: string[] | null;
  /**
   * Two shapes live here: per-record ack errors ({recordId, code, message}) and
   * whole-transmission failures written by the worker ({error}). Render
   * defensively — a missing field must never blank the screen.
   */
  errorDetails: Array<{ recordId?: string; code?: string; message?: string; error?: string }> | null;
  transmittedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export function Transmissions() {
  const me = useOutletContext<Me>();
  const dialogs = useDialogs();
  const [rows, setRows] = useState<Tx[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = () => api.get<{ transmissions: Tx[] }>('/api/iris/transmissions').then((r) => setRows(r.transmissions));
  useEffect(() => {
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  const poll = async (id: string) => {
    await api.post(`/api/iris/transmissions/${id}/poll`);
    load();
  };

  const [check, setCheck] = useState<StatusCheck | null>(null);
  // Ask the provider RIGHT NOW; a terminal verdict is applied to our records
  // immediately (via the worker's single apply path) — reload shortly after.
  const checkStatus = async (id: string) => {
    setCheck({ id, derived: 'checking…', terminal: false, applying: false, errors: [], raw: '' });
    try {
      const r = await api.get<Omit<StatusCheck, 'id'>>(`/api/iris/transmissions/${id}/status-check`);
      setCheck({ id, ...r });
      if (r.applying) {
        setTimeout(load, 2500);
        setTimeout(load, 8000);
      }
    } catch (err) {
      setCheck({ id, derived: 'error', terminal: false, applying: false, errors: [], raw: '', error: err instanceof ApiError ? err.message : String(err) });
    }
  };

  /**
   * Backfill the states a historical transmission filed. Marking a state filed
   * REMOVES those records from that state's direct-file (Pub 1220) file, so the
   * confirm spells out the consequence in both directions.
   */
  const editStatesFiled = async (t: Tx) => {
    const current = (t.statesFiled ?? []).join(', ');
    const entered = await dialogs.prompt(
      `Which states did ${t.provider} already file for this submission? Enter two-letter codes separated by commas (e.g. MO), or leave blank for none.\n\n` +
        `Records listed here are EXCLUDED from that state's direct-file upload — enter a state only if the provider really filed it. ${t.recordCount} record(s) are affected. This is recorded in the audit log.`,
      { title: 'Record state filing', defaultValue: current },
    );
    if (entered === null) return;
    const states = entered.split(',').map((s) => s.trim()).filter(Boolean);
    try {
      const r = await api.put<{ statesFiled: string[]; recordsAffected: number }>(`/api/iris/transmissions/${t.id}/states-filed`, { states });
      dialogs.toast(
        r.statesFiled.length
          ? `Recorded: ${r.statesFiled.join(', ')} filed by ${t.provider}. ${r.recordsAffected} record(s) will be excluded from those state files.`
          : `Recorded: no states filed by the provider. ${r.recordsAffected} record(s) remain available for state direct filing.`,
        'success',
      );
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const dl = async (id: string, kind: 'xml' | 'ack', utid: string) => {
    const blob = await api.get<Blob>(`/api/iris/transmissions/${id}/${kind}`);
    downloadBlob(blob, `${utid}-${kind}.xml`);
  };

  return (
    <div>
      <h1>IRS transmissions (IRIS A2A)</h1>
      <p className="muted">
        Keep Receipt IDs — IRS support requires the UTID/Receipt ID. ATS transmissions are test filings.
      </p>
      {error && <div className="error-box" onClick={() => setError('')}>{error}</div>}
      <table className="grid">
        <thead><tr><th>Payer</th><th>UTID / Receipt</th><th>Env</th><th>Year</th><th className="num">Records</th><th>Status</th><th>Transmitted</th><th></th></tr></thead>
        <tbody>
          {rows.map((t) => (
            <>
              <tr key={t.id}>
                <td>{t.payerName ?? <span className="muted">—</span>}</td>
                <td className="mono" style={{ fontSize: 11 }}>
                  {t.utid.slice(0, 20)}…{t.isCorrection && <span className="badge corrected" style={{ marginLeft: 4 }}>CORR</span>}<br />
                  {t.receiptId && <span className="muted">Receipt: {t.receiptId}</span>}
                </td>
                <td>{t.environment === 'ATS' ? <span className="badge warn">ATS TEST</span> : <span className="badge ok">PROD</span>}</td>
                <td>{t.taxYear}</td>
                <td className="num">{t.recordCount}</td>
                <td><span className={`badge ${t.status === 'accepted' ? 'accepted' : t.status === 'rejected' || t.status === 'failed' ? 'rejected' : t.status === 'accepted_with_errors' ? 'accepted_with_errors' : 'queued'}`}>{t.status}</span></td>
                <td>
                  {t.transmittedAt ? new Date(t.transmittedAt).toLocaleString() : '—'}
                  {/* state-filing history: drives whether these records still
                      need a state direct-file (MO Pub 1220) upload */}
                  <div style={{ fontSize: 11 }}>
                    {t.statesFiled === null ? (
                      <span className="badge warn" title="Filed before state history was recorded — the state direct-file may still include these records">state: unknown</span>
                    ) : t.statesFiled.length ? (
                      <span className="badge ok" title="These states were filed by the provider; the records are excluded from those state files">state: {t.statesFiled.join(', ')}</span>
                    ) : (
                      <span className="muted">federal only</span>
                    )}
                  </div>
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {/* any non-terminal transmission with a receipt can be re-polled on demand —
                      including failed ones (poll first to confirm status before re-queuing) */}
                  {t.receiptId && !['accepted', 'accepted_with_errors', 'rejected'].includes(t.status) && (<>
                    <button className="small secondary" onClick={() => poll(t.id)} title="Queue an immediate background status poll">Poll now</button>
                    <button className="small secondary" onClick={() => void checkStatus(t.id)} title="Call the provider's status API right now, show its answer, and apply a final verdict to our records">Check status</button>
                  </>)}
                  {me.role === 'admin' && (
                    <button className="small secondary" onClick={() => void editStatesFiled(t)} title="Record which states the provider already filed for this submission (affects the state direct-file)">
                      State filing…
                    </button>
                  )}
                  <button className="small secondary" onClick={() => dl(t.id, 'xml', t.utid)}>XML</button>
                  {t.resolvedAt && <button className="small secondary" onClick={() => dl(t.id, 'ack', t.utid)}>Ack</button>}
                  {t.errorDetails?.length ? (
                    <button className="small danger" onClick={() => setExpanded(expanded === t.id ? null : t.id)}>
                      {t.errorDetails.length} error(s)
                    </button>
                  ) : null}
                </td>
              </tr>
              {check?.id === t.id && (
                <tr>
                  <td colSpan={8}>
                    {check.error ? (
                      <div className="error-box">{check.error}</div>
                    ) : (
                      <>
                        <p style={{ margin: '4px 0' }}>
                          Provider says: <span className={`badge ${check.derived === 'Accepted' ? 'accepted' : check.derived === 'Rejected' ? 'rejected' : 'queued'}`}>{check.derived}</span>
                          {check.applying && <span className="muted" style={{ marginLeft: 8 }}>final verdict — applying to records now, this row will refresh…</span>}
                          {!check.terminal && check.raw && <span className="muted" style={{ marginLeft: 8 }}>still in the provider/IRS pipeline — nothing to apply yet</span>}
                        </p>
                        {check.scheduledOn && (
                          <div className="warn-box">
                            The provider is <b>holding this submission for {new Date(check.scheduledOn).toLocaleString()}</b> — it is scheduled, not
                            filed. Vibe 1099 never schedules; contact the provider to release it.
                          </div>
                        )}
                        {(check.records?.length ?? 0) > 0 && (
                          <table className="grid" style={{ fontSize: 12, marginBottom: 6 }}>
                            <thead><tr><th>Record</th><th>Provider status</th><th>Meaning</th></tr></thead>
                            <tbody>
                              {check.records!.map((r, i) => {
                                const s = r.status.toUpperCase().replace(/[\s_]+/g, '');
                                const meaning =
                                  s === 'CREATED' ? 'staged at the provider — not yet released to the IRS'
                                  : s === 'TRANSMITTED' || s === 'SENTTOAGENCY' ? 'in flight at the IRS — waiting on their verdict'
                                  : s === 'ACCEPTED' ? 'filed and accepted'
                                  : s === 'REJECTED' ? 'rejected — see the errors below'
                                  : s === 'ACCEPTEDWITHERRORS' ? 'accepted, with per-record errors'
                                  : 'in progress at the provider';
                                return (
                                  <tr key={i}>
                                    <td className="mono" style={{ fontSize: 11 }}>{r.recordId ? `${r.recordId.slice(0, 8)}…` : '—'}</td>
                                    <td>{r.status}</td>
                                    <td className="muted">{meaning}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}
                        {check.errors.length > 0 && (
                          <table className="grid"><thead><tr><th>Record</th><th>Code</th><th>Message</th></tr></thead>
                            <tbody>{check.errors.map((e, i) => (<tr key={i}><td className="mono" style={{ fontSize: 11 }}>{e.recordId ? `${e.recordId.slice(0, 8)}…` : '—'}</td><td>{e.code}</td><td>{e.message}</td></tr>))}</tbody>
                          </table>
                        )}
                        {check.raw && (
                          <details style={{ marginTop: 4 }}>
                            <summary className="muted" style={{ cursor: 'pointer' }}>Raw provider response</summary>
                            <pre style={{ fontSize: 10, whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>{check.raw}</pre>
                          </details>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              )}
              {expanded === t.id && t.errorDetails && (
                <tr>
                  <td colSpan={8}>
                    <table className="grid">
                      <thead><tr><th>Record</th><th>Code</th><th>Message</th></tr></thead>
                      <tbody>
                        {t.errorDetails.map((e, i) => (
                          <tr key={i}>
                            <td className="mono" style={{ fontSize: 11 }}>{e.recordId ? `${e.recordId.slice(0, 8)}…` : <span className="muted">whole submission</span>}</td>
                            <td>{e.code ?? (e.error ? 'TRANSMIT_FAILED' : '')}</td>
                            <td>{e.message ?? e.error ?? ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>
              )}
            </>
          ))}
          {!rows.length && <tr><td colSpan={8} className="muted">No transmissions yet. Queue forms in Form entry, then Transmit.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
