/**
 * Mock TaxBandits (SPAN Enterprises) server — integration harness for the
 * contingency filing backend. Point TAXBANDITS_MOCK_BASE_URL at this to exercise
 * the full compose → transmit → poll → ack pipeline (and TIN match + credits)
 * without hitting TaxBandits.
 *
 * Behaviors (deterministic, driven by submission content):
 *  - OAuth token endpoint returns a short-lived bearer for any signed assertion
 *  - any recipient TIN ending in 99 → per-record TIN/name mismatch error
 *  - a submissionRef whose sha256 ends in 'f' → whole-submission rejection
 *  - otherwise Accepted (with errors when any record errors exist)
 *  - first status poll returns Processing to exercise backoff
 *  - prepaid credits start at $500 and drop $0.80 per accepted submission poll
 *  - requires a Bearer token on all non-token endpoints
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

const store = new Map<string, StoredSubmission>();
let creditsCents = 50_000; // $500.00 prepaid

function requireBearer(req: express.Request, res: express.Response): boolean {
  const auth = req.headers['authorization'];
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing_bearer' });
    return false;
  }
  return true;
}

// OAuth token exchange — accepts any signed assertion in the Authorization header.
app.post('/v1.7.3/oauth/tokens', (req, res) => {
  if (!req.headers['authorization']) return void res.status(401).json({ error: 'missing_assertion' });
  res.json({ AccessToken: `TBTOK-${randomUUID().slice(0, 12)}`, ExpiresIn: 3600 });
});

app.post('/v1.7.3/form1099/create', (req, res) => {
  if (!requireBearer(req, res)) return;
  const body = req.body as { submissionRef?: string; records?: Array<{ payeeRef?: string; recipient?: { tin?: string } }> };
  const submissionRef = body.submissionRef ?? '';
  if (!submissionRef || !Array.isArray(body.records)) return void res.status(400).json({ error: 'invalid_payload' });
  const hash = createHash('sha256').update(submissionRef).digest('hex');
  for (const s of store.values()) {
    if (s.submissionId.endsWith(hash.slice(0, 8))) {
      return void res.status(409).json({ error: 'duplicate_submission', SubmissionId: s.submissionId });
    }
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

// Corrections share the create semantics for the mock.
app.post('/v1.7.3/form1099/correction', (req, res) => {
  if (!requireBearer(req, res)) return;
  const body = req.body as { submissionRef?: string; records?: Array<{ payeeRef?: string; recipient?: { tin?: string } }> };
  const submissionRef = body.submissionRef ?? '';
  const hash = createHash('sha256').update(submissionRef).digest('hex');
  const records: StoredRecord[] = (body.records ?? []).map((r) => ({ payeeRef: r.payeeRef ?? '', errors: [] }));
  const submissionId = `TBCORR-${randomUUID().slice(0, 8)}${hash.slice(0, 8)}`;
  store.set(submissionId, { submissionId, records, wholeReject: false, polls: 0 });
  res.status(200).json({ SubmissionId: submissionId, Status: 'Created' });
});

app.get('/v1.7.3/form1099/status', (req, res) => {
  if (!requireBearer(req, res)) return;
  const submissionId = String(req.query['SubmissionId'] ?? '');
  const s = store.get(submissionId);
  if (!s) return void res.status(404).json({ error: 'not_found' });
  s.polls += 1;
  if (s.polls === 1) return void res.json({ SubmissionId: submissionId, Status: 'Processing', Records: [] });
  const hasErrors = s.records.some((r) => r.errors.length);
  const Status = s.wholeReject ? 'Rejected' : hasErrors ? 'AcceptedWithErrors' : 'Accepted';
  if (Status !== 'Rejected' && s.polls === 2) creditsCents = Math.max(0, creditsCents - 80); // $0.80 per accepted
  res.json({
    SubmissionId: submissionId,
    Status,
    Records: s.records.map((r) => ({ PayeeRef: r.payeeRef, Status: r.errors.length ? 'Rejected' : 'Accepted', Errors: r.errors })),
  });
});

app.post('/v1.7.3/tinmatching/request', (req, res) => {
  if (!requireBearer(req, res)) return;
  const { TIN } = req.body as { TIN?: string };
  const match = !(TIN ?? '').replace(/\D/g, '').endsWith('99');
  res.json({ Match: match, Code: match ? 'MATCH' : 'MISMATCH', Message: match ? 'TIN and name match' : 'TIN/name mismatch' });
});

app.get('/v1.7.3/account/prepaidcredits', (req, res) => {
  if (!requireBearer(req, res)) return;
  res.json({ AvailableCredits: creditsCents / 100 });
});

app.head('/', (_req, res) => void res.status(200).end());
app.get('/', (_req, res) => void res.json({ ok: true, service: 'mock-taxbandits', submissions: store.size, creditsCents }));

const port = Number(process.env['MOCK_TAXBANDITS_PORT'] ?? 8301);
app.listen(port, () => console.log(`mock TaxBandits listening on :${port}`));
