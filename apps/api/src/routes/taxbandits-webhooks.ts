/**
 * TaxBandits webhook receiver (addendum Phase TB-D). Public edge route
 * (Cloudflare Tunnel path), POST-only.
 *
 * Authenticity (developer.taxbandits.com/docs/Webhooks/ValidatingRequests):
 * every delivery carries `Signature` and `TimeStamp` headers, where
 *   Signature = Base64( HMAC-SHA256( key = firm's ClientSecret,
 *                                    msg = ClientId + "\n" + TimeStamp ) )
 * We verify against each firm's saved TaxBandits credentials (also identifying
 * the firm). Their console has NO custom-header/secret field — this scheme is
 * the only authentication they offer. The source-IP allowlist is advisory
 * (logged, not rejected) because the HMAC is the cryptographic proof of origin
 * and TaxBandits' egress IPs are not exhaustively documented. Replays are
 * harmless: ingestion is idempotent (dedupe key) and at-least-once tolerant.
 *
 * Registering the callback URL fires a sample-payload validation POST that must
 * receive HTTP 200 or the webhook never activates; deliveries time out after
 * 5s and retry up to 9 times in 24h — so we ACK fast and reconcile async.
 *
 * On an e-file status change we don't trust the webhook body as authoritative —
 * we enqueue a status poll so the existing terminal-ack path (which applies
 * per-record results, records cost, and stores the ack blob) runs against the
 * provider's status endpoint. TIN-match webhooks update the persisted result.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { and, eq, isNotNull } from 'drizzle-orm';
import { createLogger, getCrypto, getQueue, loadEnv, normalizeTinMatchStatus, QUEUE_NAMES, type IrisPollJob } from '@vibe1099/core';
import { firms, getDb, taxbanditsWebhookEvents, tinMatchResults, transmissions } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { rateLimit } from '../middleware/rate-limit.js';

const log = createLogger('taxbandits-webhook');

export const taxbanditsWebhookRouter = Router();

/**
 * Recent auth anomalies, surfaced in Settings → TaxBandits so the operator can
 * diagnose webhook setup without shell access to the logs. In-memory ring
 * buffer (per-process, unauthenticated data stays out of the DB).
 */
export interface WebhookAnomaly {
  at: string;
  ip: string;
  kind: 'rejected' | 'accepted_offlist_ip';
  reason: string;
}
const ANOMALY_CAP = 20;
export const recentWebhookAnomalies: WebhookAnomaly[] = [];
function recordAnomaly(a: WebhookAnomaly): void {
  recentWebhookAnomalies.unshift(a);
  if (recentWebhookAnomalies.length > ANOMALY_CAP) recentWebhookAnomalies.length = ANOMALY_CAP;
}

function ipAllowed(req: { ip?: string }): boolean {
  const allow = loadEnv().TAXBANDITS_WEBHOOK_IPS.split(',').map((s) => s.trim()).filter(Boolean);
  if (!allow.length) return true;
  const ip = (req.ip ?? '').replace(/^::ffff:/, '');
  return allow.includes(ip);
}

type Verified = { ok: true; firmId: string } | { ok: false; reason: string };

/** Verify the TaxBandits HMAC signature against every firm's saved credentials. */
async function verifySignature(headers: Record<string, unknown>): Promise<Verified> {
  const sig = headers['signature'];
  const ts = headers['timestamp'];
  if (typeof sig !== 'string' || !sig || typeof ts !== 'string' || !ts) {
    return { ok: false, reason: 'signature_or_timestamp_header_missing' };
  }
  const rows = await getDb()
    .select({ id: firms.id, cid: firms.taxbanditsClientIdEncrypted, csec: firms.taxbanditsClientSecretEncrypted })
    .from(firms)
    .where(and(isNotNull(firms.taxbanditsClientIdEncrypted), isNotNull(firms.taxbanditsClientSecretEncrypted)));
  const crypto = getCrypto();
  const sigBuf = Buffer.from(sig);
  for (const f of rows) {
    if (!f.cid || !f.csec) continue;
    try {
      const expected = createHmac('sha256', crypto.decrypt(f.csec)).update(`${crypto.decrypt(f.cid)}\n${ts}`).digest('base64');
      const expBuf = Buffer.from(expected);
      if (expBuf.length === sigBuf.length && timingSafeEqual(expBuf, sigBuf)) return { ok: true, firmId: f.id };
    } catch {
      // undecryptable credentials — skip this firm
    }
  }
  return { ok: false, reason: 'signature_mismatch (no firm’s TaxBandits Client ID/Secret verifies this signature — check Settings → E-file → TaxBandits credentials)' };
}

// Reachability probe: the TaxBandits console (and an operator with a browser)
// checks the URL before any signed event ever fires. Answer 200 with no data —
// event ingestion below still requires a valid signature.
taxbanditsWebhookRouter.get('/', (_req, res) => {
  res.json({ ok: true, service: 'vibe1099-taxbandits-webhook', accepts: 'POST' });
});

interface WebhookRecord {
  RecordId?: string;
  RecipientId?: string;
  PayeeRef?: string;
  Status?: string;
  StatusCode?: number;
  StatusTime?: string;
}

taxbanditsWebhookRouter.post(
  '/',
  rateLimit({ key: 'tbwebhook', limit: 120, windowSec: 60 }),
  h(async (req, res) => {
    const verdict = await verifySignature(req.headers as Record<string, unknown>);
    if (!verdict.ok) {
      log.warn({ ip: req.ip, reason: verdict.reason }, 'rejected TaxBandits webhook');
      recordAnomaly({ at: new Date().toISOString(), ip: req.ip ?? '', kind: 'rejected', reason: verdict.reason });
      return void res.status(401).json({ error: 'unauthorized' });
    }
    if (!ipAllowed(req)) {
      // signature already proves origin; a new/undocumented TaxBandits egress IP
      // must not break status delivery — surface it for the operator instead.
      log.warn({ ip: req.ip }, 'TaxBandits webhook from non-allowlisted IP (accepted — signature verified); consider updating TAXBANDITS_WEBHOOK_IPS');
      recordAnomaly({ at: new Date().toISOString(), ip: req.ip ?? '', kind: 'accepted_offlist_ip', reason: 'signature verified; IP not in TAXBANDITS_WEBHOOK_IPS' });
    }

    // Real deliveries are nested (SubmissionId + Records[]); older/mock shapes
    // are flat — tolerate both.
    const body = req.body as {
      eventType?: string;
      EventType?: string;
      submissionId?: string;
      SubmissionId?: string;
      recordId?: string;
      RecordId?: string;
      status?: string;
      Status?: string;
      timestamp?: string;
      payeeRef?: string;
      PayeeRef?: string;
      FormType?: string;
      Records?: WebhookRecord[];
    };
    const records = Array.isArray(body.Records) ? body.Records : [];
    const eventType = body.eventType ?? body.EventType ?? (records.length ? 'EfileStatusChange' : 'unknown');
    const submissionId = body.submissionId ?? body.SubmissionId ?? null;
    const recordId = body.recordId ?? body.RecordId ?? records[0]?.RecordId ?? null;
    const status = body.status ?? body.Status ?? records[0]?.Status ?? null;
    const payeeRef = body.payeeRef ?? body.PayeeRef ?? records[0]?.PayeeRef ?? null;
    const dedupeKey = createHash('sha256')
      .update(
        [eventType, submissionId, recordId, status, body.timestamp ?? '', ...records.map((r) => `${r.RecordId ?? ''}:${r.Status ?? ''}:${r.StatusTime ?? ''}`)].join('|'),
      )
      .digest('hex');

    const db = getDb();
    // Idempotent insert — a duplicate delivery hits the unique dedupe index.
    const inserted = await db
      .insert(taxbanditsWebhookEvents)
      .values({ dedupeKey, eventType, submissionId, recordId, status, payload: body as Record<string, unknown> })
      .onConflictDoNothing({ target: taxbanditsWebhookEvents.dedupeKey })
      .returning({ id: taxbanditsWebhookEvents.id });
    if (!inserted.length) {
      return void res.status(200).json({ ok: true, duplicate: true }); // already processed
    }

    try {
      // E-file status: reconcile via the authoritative status endpoint. Real
      // payloads carry no explicit event-type field, so key on the submission
      // matching one of OUR transmissions rather than on a name.
      const tx = submissionId
        ? await db.query.transmissions.findFirst({
            where: and(eq(transmissions.receiptId, submissionId), eq(transmissions.provider, 'taxbandits')),
          })
        : null;
      if (tx) {
        if (tx.status !== 'accepted' && tx.status !== 'accepted_with_errors' && tx.status !== 'rejected') {
          const poll: IrisPollJob = { kind: 'poll', transmissionId: tx.id, firmId: tx.firmId, attempt: 0 };
          await getQueue(QUEUE_NAMES.iris).add('poll', poll);
        }
      } else if (/tin/i.test(eventType) || submissionId || payeeRef) {
        // TIN-match verdict: update the pending row for this submission/payee.
        // The authoritative housekeeping poll also reconciles these; unmatched
        // WHERE clauses no-op safely.
        const tinVerdict = normalizeTinMatchStatus(status ?? '');
        if (tinVerdict !== 'pending') {
          const conds = [eq(tinMatchResults.provider, 'taxbandits'), eq(tinMatchResults.status, 'pending')];
          if (submissionId) conds.push(eq(tinMatchResults.submissionRef, submissionId));
          else if (payeeRef) conds.push(eq(tinMatchResults.recipientId, payeeRef));
          await db
            .update(tinMatchResults)
            .set({ status: tinVerdict, code: status ?? '', message: `IRS TIN matching: ${status ?? ''}`, checkedAt: new Date() })
            .where(and(...conds));
        }
      }
      await db.update(taxbanditsWebhookEvents).set({ processedAt: new Date() }).where(eq(taxbanditsWebhookEvents.dedupeKey, dedupeKey));
    } catch (err) {
      log.error({ err, eventType }, 'webhook processing failed (stored for replay)');
    }
    res.status(200).json({ ok: true });
  }),
);
