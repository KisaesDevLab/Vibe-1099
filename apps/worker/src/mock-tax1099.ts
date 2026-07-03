/**
 * Mock Tax1099 (Zenwork) server — integration harness for the managed-filing
 * backend. Point TAX1099_MOCK_BASE_URL at this to exercise the full
 * compose → transmit → poll → ack pipeline without hitting Zenwork.
 *
 * Behaviors (deterministic, driven by submission content):
 *  - any recipient TIN ending in 99 → per-form TIN/name mismatch error
 *  - a submissionRef whose sha256 ends in 'f' → whole-submission rejection
 *  - otherwise Accepted (with errors when any form errors exist)
 *  - first status poll returns Processing to exercise backoff
 *  - requires the app key header (Authorization / x-api-key)
 *
 * Run: pnpm --filter @vibe1099/worker mock-tax1099   (port 8300)
 */
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';

const app = express();
app.use(express.json({ limit: '120mb' }));

interface StoredForm {
  refId: string;
  errors: Array<{ code: string; message: string }>;
}
interface StoredSubmission {
  submissionId: string;
  forms: StoredForm[];
  wholeReject: boolean;
  polls: number;
}

const store = new Map<string, StoredSubmission>();

function requireKey(req: express.Request, res: express.Response): boolean {
  const key = req.headers['authorization'] || req.headers['x-api-key'];
  if (!key) {
    res.status(401).json({ error: 'missing_api_key' });
    return false;
  }
  return true;
}

app.post('/api/v2/efile', (req, res) => {
  if (!requireKey(req, res)) return;
  const body = req.body as {
    submissionRef?: string;
    forms?: Array<{ refId?: string; recipient?: { tin?: string } }>;
  };
  const submissionRef = body.submissionRef ?? '';
  if (!submissionRef || !Array.isArray(body.forms)) {
    return void res.status(400).json({ error: 'invalid_payload' });
  }
  // idempotency: same submissionRef returns the same submissionId
  for (const s of store.values()) {
    if (s.submissionId.endsWith(createHash('sha256').update(submissionRef).digest('hex').slice(0, 8))) {
      return void res.status(409).json({ error: 'duplicate_submission', submissionId: s.submissionId });
    }
  }
  const forms: StoredForm[] = body.forms.map((f) => {
    const tin = (f.recipient?.tin ?? '').replace(/\D/g, '');
    const errors = tin.endsWith('99')
      ? [{ code: 'TINNAME_MISMATCH', message: 'Recipient TIN and name do not match IRS records' }]
      : [];
    return { refId: f.refId ?? '', errors };
  });
  const wholeReject = createHash('sha256').update(submissionRef).digest('hex').endsWith('f');
  const submissionId = `T99SUB-${randomUUID().slice(0, 8)}${createHash('sha256').update(submissionRef).digest('hex').slice(0, 8)}`;
  store.set(submissionId, { submissionId, forms, wholeReject, polls: 0 });
  res.status(200).json({ submissionId, status: 'Submitted' });
});

app.get('/api/v2/efile/status', (req, res) => {
  if (!requireKey(req, res)) return;
  const submissionId = String(req.query['submissionId'] ?? '');
  const s = store.get(submissionId);
  if (!s) return void res.status(404).json({ error: 'not_found' });
  s.polls += 1;
  if (s.polls === 1) {
    return void res.json({ submissionId, status: 'Processing', forms: [] });
  }
  const hasErrors = s.forms.some((f) => f.errors.length);
  const status = s.wholeReject ? 'Rejected' : hasErrors ? 'Accepted with Errors' : 'Accepted';
  res.json({
    submissionId,
    status,
    forms: s.forms.map((f) => ({ refId: f.refId, status: f.errors.length ? 'Rejected' : 'Accepted', errors: f.errors })),
  });
});

// Phase 2 add-on stubs -------------------------------------------------------

app.post('/api/v2/tinmatch', (req, res) => {
  if (!requireKey(req, res)) return;
  const { tin } = req.body as { tin?: string };
  const match = !(tin ?? '').replace(/\D/g, '').endsWith('99');
  res.json({ match, code: match ? 'MATCH' : 'MISMATCH', message: match ? 'TIN and name match' : 'TIN/name mismatch' });
});

app.post('/api/v2/mail', (req, res) => {
  if (!requireKey(req, res)) return;
  res.json({ mailId: `MAIL-${randomUUID().slice(0, 8)}` });
});

app.post('/api/v2/w9/request', (req, res) => {
  if (!requireKey(req, res)) return;
  res.json({ requestId: `W9-${randomUUID().slice(0, 8)}` });
});

app.head('/', (_req, res) => void res.status(200).end());
app.get('/', (_req, res) => void res.json({ ok: true, service: 'mock-tax1099', submissions: store.size }));

const port = Number(process.env['MOCK_TAX1099_PORT'] ?? 8300);
app.listen(port, () => console.log(`mock Tax1099 listening on :${port}`));
