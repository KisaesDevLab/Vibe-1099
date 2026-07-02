import { useEffect, useState } from 'react';
import { api, downloadBlob } from '../api';

interface Tx {
  id: string;
  taxYear: number;
  environment: 'ATS' | 'PROD';
  utid: string;
  receiptId: string | null;
  status: string;
  isCorrection: boolean;
  recordCount: number;
  errorDetails: Array<{ recordId: string; code: string; message: string }> | null;
  transmittedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export function Transmissions() {
  const [rows, setRows] = useState<Tx[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

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
      <table className="grid">
        <thead><tr><th>UTID / Receipt</th><th>Env</th><th>Year</th><th className="num">Records</th><th>Status</th><th>Transmitted</th><th></th></tr></thead>
        <tbody>
          {rows.map((t) => (
            <>
              <tr key={t.id}>
                <td className="mono" style={{ fontSize: 11 }}>
                  {t.utid.slice(0, 20)}…{t.isCorrection && <span className="badge corrected" style={{ marginLeft: 4 }}>CORR</span>}<br />
                  {t.receiptId && <span className="muted">Receipt: {t.receiptId}</span>}
                </td>
                <td>{t.environment === 'ATS' ? <span className="badge warn">ATS TEST</span> : <span className="badge ok">PROD</span>}</td>
                <td>{t.taxYear}</td>
                <td className="num">{t.recordCount}</td>
                <td><span className={`badge ${t.status === 'accepted' ? 'accepted' : t.status === 'rejected' || t.status === 'failed' ? 'rejected' : t.status === 'accepted_with_errors' ? 'accepted_with_errors' : 'queued'}`}>{t.status}</span></td>
                <td>{t.transmittedAt ? new Date(t.transmittedAt).toLocaleString() : '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {t.status === 'polling' && <button className="small secondary" onClick={() => poll(t.id)}>Poll now</button>}
                  <button className="small secondary" onClick={() => dl(t.id, 'xml', t.utid)}>XML</button>
                  {t.resolvedAt && <button className="small secondary" onClick={() => dl(t.id, 'ack', t.utid)}>Ack</button>}
                  {t.errorDetails?.length ? (
                    <button className="small danger" onClick={() => setExpanded(expanded === t.id ? null : t.id)}>
                      {t.errorDetails.length} error(s)
                    </button>
                  ) : null}
                </td>
              </tr>
              {expanded === t.id && t.errorDetails && (
                <tr>
                  <td colSpan={7}>
                    <table className="grid">
                      <thead><tr><th>Record</th><th>Code</th><th>Message</th></tr></thead>
                      <tbody>
                        {t.errorDetails.map((e, i) => (
                          <tr key={i}><td className="mono" style={{ fontSize: 11 }}>{e.recordId.slice(0, 8)}…</td><td>{e.code}</td><td>{e.message}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>
              )}
            </>
          ))}
          {!rows.length && <tr><td colSpan={7} className="muted">No transmissions yet. Queue forms in Form entry, then Transmit.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
