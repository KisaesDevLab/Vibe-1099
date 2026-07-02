/**
 * Mock IRIS server (Phase 9 integration harness) — recorded ATS-style
 * responses. Point IRIS_MOCK_BASE_URL at this to exercise the full
 * transmit → poll → ack pipeline without the IRS.
 *
 * Behaviors (deterministic, driven by the submission content):
 *  - any recipient TIN ending in 99 → record-level TIN/name mismatch error
 *  - a transmission whose UTID hash ends in 'f' → whole-file rejection
 *  - otherwise Accepted (with errors when any record errors exist)
 *  - first status poll returns Processing to exercise backoff
 *
 * Run: pnpm --filter @vibe1099/worker mock-iris   (port 8299)
 */
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';

const app = express();
app.use(express.text({ type: ['application/xml', 'text/xml'], limit: '120mb' }));
app.use(express.urlencoded({ extended: false }));

interface StoredTransmission {
  receiptId: string;
  utid: string;
  recordErrors: Array<{ recordId: string; code: string; message: string }>;
  wholeFileReject: boolean;
  polls: number;
}

const store = new Map<string, StoredTransmission>();

app.post('/auth/oauth/v2/token', (req, res) => {
  const assertion = String((req.body as Record<string, string>)['client_assertion'] ?? '');
  if (!assertion || assertion.split('.').length !== 3) {
    return void res.status(401).json({ error: 'invalid_client', error_description: 'bad assertion' });
  }
  res.json({ access_token: `mock-${randomUUID()}`, token_type: 'Bearer', expires_in: 3600 });
});

app.post('/a2a/1099/transmissions', (req, res) => {
  const xml = String(req.body ?? '');
  const utid = /<UniqueTransmissionId>([^<]+)<\/UniqueTransmissionId>/.exec(xml)?.[1] ?? '';
  if (!utid) {
    return void res.status(400).type('application/xml').send('<Error><ErrorMessageTxt>Missing UTID</ErrorMessageTxt></Error>');
  }
  // duplicate UTID guard — mirrors IRIS behavior
  for (const t of store.values()) {
    if (t.utid === utid) {
      return void res
        .status(409)
        .type('application/xml')
        .send('<Error><ErrorMessageCd>R-TRANS-004</ErrorMessageCd><ErrorMessageTxt>Duplicate UTID</ErrorMessageTxt></Error>');
    }
  }

  const recordErrors: StoredTransmission['recordErrors'] = [];
  const detailRe = /<(?:Form1099\w+)Detail recordId="([^"]+)">([\s\S]*?)<\/(?:Form1099\w+)Detail>/g;
  let m: RegExpExecArray | null;
  while ((m = detailRe.exec(xml))) {
    const recordId = m[1] ?? '';
    const body = m[2] ?? '';
    const tin = /<TIN>(\d{9})<\/TIN>/.exec(body)?.[1] ?? '';
    if (tin.endsWith('99')) {
      recordErrors.push({
        recordId,
        code: 'R-1099-NEC-001',
        message: 'PayeeTIN and PayeeName do not match IRS records',
      });
    }
  }

  const wholeFileReject = createHash('sha256').update(utid).digest('hex').endsWith('f');
  const receiptId = `MOCK-${randomUUID()}`;
  store.set(receiptId, { receiptId, utid, recordErrors, wholeFileReject, polls: 0 });

  res
    .status(200)
    .type('application/xml')
    .send(`<TransmissionResponse><ReceiptId>${receiptId}</ReceiptId><StatusCd>Processing</StatusCd></TransmissionResponse>`);
});

app.get('/a2a/1099/transmissions/status', (req, res) => {
  const receiptId = String(req.query['receiptId'] ?? '');
  const t = store.get(receiptId);
  if (!t) return void res.status(404).type('application/xml').send('<Error><ErrorMessageTxt>Unknown receipt</ErrorMessageTxt></Error>');
  t.polls += 1;
  if (t.polls === 1) {
    return void res
      .type('application/xml')
      .send(`<StatusResponse><ReceiptId>${receiptId}</ReceiptId><TransmissionStatusCd>Processing</TransmissionStatusCd></StatusResponse>`);
  }
  const status = t.wholeFileReject ? 'Rejected' : t.recordErrors.length ? 'AcceptedWithErrors' : 'Accepted';
  const errorsXml = t.recordErrors
    .map(
      (e) =>
        `<ErrorDetailGrp><RecordId>${e.recordId}</RecordId><ErrorMessageCd>${e.code}</ErrorMessageCd><ErrorMessageTxt>${e.message}</ErrorMessageTxt></ErrorDetailGrp>`,
    )
    .join('');
  res
    .type('application/xml')
    .send(
      `<StatusResponse><ReceiptId>${receiptId}</ReceiptId><TransmissionStatusCd>${status}</TransmissionStatusCd>${errorsXml}</StatusResponse>`,
    );
});

app.head('/', (_req, res) => void res.status(200).end());
app.get('/', (_req, res) => void res.json({ ok: true, service: 'mock-iris', transmissions: store.size }));

const port = Number(process.env['MOCK_IRIS_PORT'] ?? 8299);
app.listen(port, () => console.log(`mock IRIS listening on :${port}`));
