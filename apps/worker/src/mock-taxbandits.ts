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
  /** Create only STAGES (CREATED); the per-form Transmit call releases to the IRS. */
  released: boolean;
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

// Real wire contract: { SubmissionManifest, ReturnHeader: { Business }, ReturnData: [...] }.
// The mock validates it the way production does — a payload without ReturnHeader
// gets the exact F01-100064 error the live API returns, so a contract regression
// can never pass locally again.
interface WireReturnData {
  SequenceId?: string;
  Recipient?: { TIN?: string; PayeeRef?: string };
}
interface WireCreateBody {
  SubmissionManifest?: { TaxYear?: string };
  ReturnHeader?: { Business?: Record<string, unknown> };
  ReturnData?: WireReturnData[];
}

function wireError(res: express.Response, id: string, name: string, message: string): void {
  res.status(400).json({ StatusCode: 400, StatusName: 'BadRequest', StatusMessage: 'Validation error has occurred', Errors: [{ Id: id, Name: name, Message: message }] });
}

function validateWire(req: express.Request, res: express.Response): WireCreateBody | null {
  const body = req.body as WireCreateBody;
  if (!body.ReturnHeader?.Business) {
    wireError(res, 'F01-100064', 'ReturnHeader', 'ReturnHeader should not be null');
    return null;
  }
  if (!Array.isArray(body.ReturnData) || !body.ReturnData.length) {
    wireError(res, 'F01-100065', 'ReturnData', 'ReturnData should not be null');
    return null;
  }
  return body;
}

const FORM_TYPES = ['NEC', 'MISC', 'INT', 'DIV'] as const;
for (const ft of FORM_TYPES) {
  app.post(`/v1.7.3/Form1099${ft}/Create`, (req, res) => {
    if (!requireBearer(req, res)) return;
    const body = validateWire(req, res);
    if (!body) return;
    const hash = createHash('sha256').update(JSON.stringify(req.body)).digest('hex');
    for (const s of store.values()) {
      if (s.submissionId.endsWith(hash.slice(0, 8))) return void res.status(409).json({ error: 'duplicate_submission', SubmissionId: s.submissionId });
    }
    const records: StoredRecord[] = body.ReturnData!.map((r) => {
      const tin = (r.Recipient?.TIN ?? '').replace(/\D/g, '');
      const errors = tin.endsWith('99') ? [{ Code: 'TINNAME_MISMATCH', Message: 'Recipient TIN and name do not match IRS records' }] : [];
      return { payeeRef: r.Recipient?.PayeeRef ?? '', errors };
    });
    const submissionId = `TBSUB-${randomUUID().slice(0, 8)}${hash.slice(0, 8)}`;
    store.set(submissionId, { submissionId, records, wholeReject: hash.endsWith('f'), polls: 0, released: false });
    res.status(200).json({ SubmissionId: submissionId, Status: 'Created' });
  });

  // Mandatory second step: releases a CREATED submission to the (mock) IRS.
  app.post(`/v1.7.3/Form1099${ft}/Transmit`, (req, res) => {
    if (!requireBearer(req, res)) return;
    const { SubmissionId } = req.body as { SubmissionId?: string };
    const s = store.get(SubmissionId ?? '');
    if (!s) return void res.status(404).json({ error: 'not_found' });
    s.released = true;
    s.polls = 0;
    res.json({ StatusCode: 200, StatusName: 'Ok', SubmissionId: s.submissionId, Errors: null });
  });

  app.post(`/v1.7.3/Form1099${ft}/Correction`, (req, res) => {
    if (!requireBearer(req, res)) return;
    const body = validateWire(req, res);
    if (!body) return;
    const hash = createHash('sha256').update(JSON.stringify(req.body)).digest('hex');
    const records: StoredRecord[] = body.ReturnData!.map((r) => ({ payeeRef: r.Recipient?.PayeeRef ?? '', errors: [] }));
    const submissionId = `TBCORR-${randomUUID().slice(0, 8)}${hash.slice(0, 8)}`;
    store.set(submissionId, { submissionId, records, wholeReject: false, polls: 0, released: false });
    res.status(200).json({ SubmissionId: submissionId, Status: 'Created' });
  });

  // Real Status contract: no top-level status — per-record verdicts under
  // Form1099Records.SuccessRecords[].FederalReturn (first poll: SENT TO AGENCY).
  app.get(`/v1.7.3/Form1099${ft}/Status`, (req, res) => {
    if (!requireBearer(req, res)) return;
    const submissionId = String(req.query['SubmissionId'] ?? '');
    const s = store.get(submissionId);
    if (!s) return void res.status(404).json({ error: 'not_found' });
    if (s.released) s.polls += 1;
    if (s.released && !s.wholeReject && s.polls === 2) creditsCents = Math.max(0, creditsCents - 80);
    res.json({
      StatusCode: 200,
      StatusName: 'Success',
      SubmissionId: submissionId,
      Form1099Records: {
        SuccessRecords: s.records.map((r, i) => ({
          SequenceId: String(i + 1),
          RecordId: `TBREC-${i + 1}`,
          PayeeRef: r.payeeRef,
          FederalReturn: !s.released
            ? { Status: 'CREATED', Errors: null } // staged only — awaiting the Transmit call
            : s.polls === 1
              ? { Status: 'SENT TO AGENCY', Errors: null }
              : {
                  Status: s.wholeReject || r.errors.length ? 'REJECTED' : 'ACCEPTED',
                  Errors: r.errors.length ? r.errors.map((e) => ({ Id: e.Code, Name: 'Recipient', Message: e.Message })) : null,
                },
        })),
        ErrorRecords: null,
      },
      Errors: null,
    });
  });
}

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
