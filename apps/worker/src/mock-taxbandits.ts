/**
 * Mock TaxBandits (SPAN Enterprises) server — integration harness aligned to the
 * real API contract (verified against developer.taxbandits.com). Point
 * TAXBANDITS_MOCK_BASE_URL at this to exercise auth → transmit → poll → ack,
 * async TIN matching, and credits without hitting TaxBandits.
 *
 * Contract mirrored:
 *  - OAuth: GET /v2/tbsauth with the JWS in the `Authentication` header →
 *    { AccessToken, TokenType, ExpiresIn }
 *  - API calls: Bearer access token; PascalCase request/response shapes
 *  - TIN matching is ASYNC: Request returns Order Created; Status returns the
 *    Success/Failed verdict (sandbox rule: recipient TIN ending in 000 → Failed)
 *  - e-file: recipient TIN ending in 99 → per-record error; submissionRef sha
 *    ending in 'f' → whole-submission rejection; first status poll → Processing
 *
 * Run: pnpm --filter @vibe1099/worker mock-taxbandits   (port 8301)
 */
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';

const app = express();
app.use(express.json({ limit: '120mb' }));

interface StoredRecord {
  payeeRef: string;
  errors: Array<{ Code: string; Message: string }>;
}
interface StoredSubmission {
  submissionId: string;
  records: StoredRecord[];
  wholeReject: boolean;
  polls: number;
}
interface StoredTinMatch {
  submissionId: string;
  records: Array<{ recordId: string; sequenceId: string; tin: string }>;
  polls: number;
}

const store = new Map<string, StoredSubmission>();
const tinStore = new Map<string, StoredTinMatch>();
let creditsCents = 50_000; // $500.00 prepaid

function requireBearer(req: express.Request, res: express.Response): boolean {
  const auth = req.headers['authorization'];
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
    res.status(401).json({ StatusCode: 401, StatusName: 'Unauthorized', StatusMessage: 'Invalid authorization credentials' });
    return false;
  }
  return true;
}

// OAuth token exchange — GET with the JWS in the custom `Authentication` header.
app.get('/v2/tbsauth', (req, res) => {
  if (!req.headers['authentication']) {
    return void res.status(401).json({ StatusCode: 401, StatusName: 'Unauthorized', StatusMessage: 'Invalid authorization credentials', Errors: [{ Id: 'AUTH-100026', Name: 'Authorization', Message: 'Authorization Failed' }] });
  }
  res.json({ AccessToken: `TBTOK-${randomUUID().slice(0, 12)}`, TokenType: 'Bearer', ExpiresIn: 3600 });
});

app.post('/v1.7.3/Form1099NEC/Create', (req, res) => {
  if (!requireBearer(req, res)) return;
  const body = req.body as { submissionRef?: string; records?: Array<{ payeeRef?: string; recipient?: { tin?: string } }> };
  const submissionRef = body.submissionRef ?? '';
  if (!submissionRef || !Array.isArray(body.records)) return void res.status(400).json({ error: 'invalid_payload' });
  const hash = createHash('sha256').update(submissionRef).digest('hex');
  for (const s of store.values()) {
    if (s.submissionId.endsWith(hash.slice(0, 8))) return void res.status(409).json({ error: 'duplicate_submission', SubmissionId: s.submissionId });
  }
  const records: StoredRecord[] = body.records.map((r) => {
    const tin = (r.recipient?.tin ?? '').replace(/\D/g, '');
    const errors = tin.endsWith('99') ? [{ Code: 'TINNAME_MISMATCH', Message: 'Recipient TIN and name do not match IRS records' }] : [];
    return { payeeRef: r.payeeRef ?? '', errors };
  });
  const submissionId = `TBSUB-${randomUUID().slice(0, 8)}${hash.slice(0, 8)}`;
  store.set(submissionId, { submissionId, records, wholeReject: hash.endsWith('f'), polls: 0 });
  res.status(200).json({ SubmissionId: submissionId, Status: 'Created' });
});

app.post('/v1.7.3/Form1099NEC/Correction', (req, res) => {
  if (!requireBearer(req, res)) return;
  const body = req.body as { submissionRef?: string; records?: Array<{ payeeRef?: string }> };
  const hash = createHash('sha256').update(body.submissionRef ?? '').digest('hex');
  const records: StoredRecord[] = (body.records ?? []).map((r) => ({ payeeRef: r.payeeRef ?? '', errors: [] }));
  const submissionId = `TBCORR-${randomUUID().slice(0, 8)}${hash.slice(0, 8)}`;
  store.set(submissionId, { submissionId, records, wholeReject: false, polls: 0 });
  res.status(200).json({ SubmissionId: submissionId, Status: 'Created' });
});

app.get('/v1.7.3/Form1099NEC/Status', (req, res) => {
  if (!requireBearer(req, res)) return;
  const submissionId = String(req.query['SubmissionId'] ?? '');
  const s = store.get(submissionId);
  if (!s) return void res.status(404).json({ error: 'not_found' });
  s.polls += 1;
  if (s.polls === 1) return void res.json({ SubmissionId: submissionId, Status: 'Processing', Records: [] });
  const hasErrors = s.records.some((r) => r.errors.length);
  const Status = s.wholeReject ? 'Rejected' : hasErrors ? 'AcceptedWithErrors' : 'Accepted';
  if (Status !== 'Rejected' && s.polls === 2) creditsCents = Math.max(0, creditsCents - 80);
  res.json({
    SubmissionId: submissionId,
    Status,
    Records: s.records.map((r) => ({ PayeeRef: r.payeeRef, Status: r.errors.length ? 'Rejected' : 'Accepted', Errors: r.errors })),
  });
});

// Async TIN matching -----------------------------------------------------------
app.post('/v1.7.3/TINMatchingRecipients/Request', (req, res) => {
  if (!requireBearer(req, res)) return;
  const body = req.body as { TINMatchingDetails?: { Recipients?: Array<{ SequenceId?: string; TIN?: string }> } };
  const recips = body.TINMatchingDetails?.Recipients ?? [];
  const submissionId = randomUUID();
  const records = recips.map((r) => ({ recordId: randomUUID(), sequenceId: r.SequenceId ?? '', tin: (r.TIN ?? '').replace(/\D/g, '') }));
  tinStore.set(submissionId, { submissionId, records, polls: 0 });
  res.status(200).json({
    SubmissionId: submissionId,
    TINMatchingRecords: { SuccessRecords: records.map((r) => ({ RecordId: r.recordId, SequenceId: r.sequenceId, Status: 'Order Created' })) },
  });
});

app.get('/v1.7.3/TINMatchingRecipients/Status', (req, res) => {
  if (!requireBearer(req, res)) return;
  const submissionId = String(req.query['SubmissionId'] ?? '');
  const s = tinStore.get(submissionId);
  if (!s) return void res.status(404).json({ error: 'not_found' });
  s.polls += 1;
  // first poll still processing; subsequent polls return the verdict
  res.json({
    SubmissionId: submissionId,
    Records: s.records.map((r) => ({
      RecordId: r.recordId,
      SequenceId: r.sequenceId,
      RecipientId: r.sequenceId,
      // sandbox rule: TIN ending in 000 fails, others succeed
      Status: s.polls < 2 ? 'Under Process' : r.tin.endsWith('000') ? 'Failed' : 'Success',
    })),
  });
});

app.get('/v1.7.3/Account/GetCredits', (req, res) => {
  if (!requireBearer(req, res)) return;
  res.json({ AvailableCredits: creditsCents / 100 });
});

app.head('/', (_req, res) => void res.status(200).end());
app.get('/', (_req, res) => void res.json({ ok: true, service: 'mock-taxbandits', submissions: store.size, tinMatches: tinStore.size, creditsCents }));

const port = Number(process.env['MOCK_TAXBANDITS_PORT'] ?? 8301);
app.listen(port, () => console.log(`mock TaxBandits listening on :${port}`));
