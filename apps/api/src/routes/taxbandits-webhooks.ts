/**
 * TaxBandits webhook receiver (addendum Phase TB-D). Public edge route
 * (Cloudflare Tunnel path), POST-only. Authenticity: source-IP allowlist
 * (documented TaxBandits IPs, config-driven) PLUS a shared-secret header,
 * timing-safe. Ingestion is idempotent (dedupe key) and at-least-once tolerant.
 *
 * On an e-file status change we don't trust the webhook body as authoritative —
 * we enqueue a status poll so the existing terminal-ack path (which applies
 * per-record results, records cost, and stores the ack blob) runs against the
 * provider's status endpoint. TIN-match webhooks update the persisted result.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { createLogger, getQueue, loadEnv, QUEUE_NAMES, type IrisPollJob } from '@vibe1099/core';
import { getDb, recipients, taxbanditsWebhookEvents, tinMatchResults, transmissions } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { rateLimit } from '../middleware/rate-limit.js';

const log = createLogger('taxbandits-webhook');

export const taxbanditsWebhookRouter = Router();

function ipAllowed(req: { ip?: string }): boolean {
  const allow = loadEnv().TAXBANDITS_WEBHOOK_IPS.split(',').map((s) => s.trim()).filter(Boolean);
  if (!allow.length) return true; // not configured → don't hard-fail (secret still required)
  const ip = (req.ip ?? '').replace(/^::ffff:/, '');
  return allow.includes(ip);
}

function secretOk(headerVal: unknown): boolean {
  const secret = loadEnv().TAXBANDITS_WEBHOOK_SECRET;
  if (!secret) return false; // fail closed if no secret configured
  if (typeof headerVal !== 'string') return false;
  const a = Buffer.from(headerVal);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

taxbanditsWebhookRouter.post(
  '/',
  rateLimit({ key: 'tbwebhook', limit: 120, windowSec: 60 }),
  h(async (req, res) => {
    if (!secretOk(req.headers['x-taxbandits-signature']) || !ipAllowed(req)) {
      log.warn({ ip: req.ip }, 'rejected TaxBandits webhook (auth)');
      return void res.status(401).json({ error: 'unauthorized' });
    }
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
    };
    const eventType = body.eventType ?? body.EventType ?? 'unknown';
    const submissionId = body.submissionId ?? body.SubmissionId ?? null;
    const recordId = body.recordId ?? body.RecordId ?? null;
    const status = body.status ?? body.Status ?? null;
    const dedupeKey = createHash('sha256')
      .update([eventType, submissionId, recordId, status, body.timestamp ?? ''].join('|'))
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
      if (/efile|status/i.test(eventType) && submissionId) {
        // reconcile via the authoritative status endpoint
        const tx = await db.query.transmissions.findFirst({
          where: and(eq(transmissions.receiptId, submissionId), eq(transmissions.provider, 'taxbandits')),
        });
        if (tx && tx.status !== 'accepted' && tx.status !== 'accepted_with_errors' && tx.status !== 'rejected') {
          const poll: IrisPollJob = { kind: 'poll', transmissionId: tx.id, firmId: tx.firmId, attempt: 0 };
          await getQueue(QUEUE_NAMES.iris).add('poll', poll);
        }
      } else if (/tin/i.test(eventType) && body.payeeRef) {
        const recip = await db.query.recipients.findFirst({ where: eq(recipients.id, body.payeeRef) });
        if (recip) {
          const matched = /match(?!.*mismatch)/i.test(status ?? '');
          await db.insert(tinMatchResults).values({
            firmId: recip.firmId,
            recipientId: recip.id,
            provider: 'taxbandits',
            status: matched ? 'match' : 'mismatch',
            code: status ?? '',
            message: 'via webhook',
          });
        }
      }
      await db.update(taxbanditsWebhookEvents).set({ processedAt: new Date() }).where(eq(taxbanditsWebhookEvents.dedupeKey, dedupeKey));
    } catch (err) {
      log.error({ err, eventType }, 'webhook processing failed (stored for replay)');
    }
    res.status(200).json({ ok: true });
  }),
);
