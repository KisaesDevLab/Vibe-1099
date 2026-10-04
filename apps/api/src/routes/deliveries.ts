/**
 * Delivery composer + tracking (Phase 8, staff side).
 * Per-recipient channel resolution: email preferred, SMS fallback, none → paper-only badge.
 * Links carry opaque tokens only — no TIN, no name in URLs.
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, zTaxYear } from '@vibe1099/shared';
import { getCrypto, getQueue, loadEnv, QUEUE_NAMES, type DeliveryJob } from '@vibe1099/core';
import { deliveries, firms, formRecords, getDb, payers, recipients } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { requireStaff } from '../middleware/auth.js';
import { getSetting } from '../services/settings.js';

export const deliveriesRouter = Router();
deliveriesRouter.use(requireStaff());

/** Oct 15 of the year after filing season (portal availability policy). */
async function tokenExpiry(taxYear: number): Promise<Date> {
  const policy = (await getSetting<string>('portal_available_until')) ?? 'oct15';
  if (policy === 'oct15') return new Date(Date.UTC(taxYear + 1, 9, 15, 23, 59, 59));
  const days = (await getSetting<number>('recipient_token_days')) ?? 90;
  return new Date(Date.now() + days * 86_400_000);
}

export async function createPortalDelivery(opts: {
  firmId: string;
  formRecordId: string;
  channel: 'email' | 'sms';
  isCorrected: boolean;
  /** precomputed by bulk callers (one settings read per compose, not per form) */
  expiresAt?: Date;
}): Promise<{ deliveryId: string; token: string; expiresAt: Date }> {
  const db = getDb();
  const crypto = getCrypto();
  let expiresAt = opts.expiresAt;
  if (!expiresAt) {
    const record = await db.query.formRecords.findFirst({ where: and(eq(formRecords.id, opts.formRecordId), eq(formRecords.firmId, opts.firmId)) });
    if (!record) throw AppError.notFound('Form record');
    expiresAt = await tokenExpiry(record.taxYear);
  }
  // The token embeds the delivery id: mint the id first and insert the REAL hash
  // in one statement — a 'pending' placeholder collides on the unique token_hash
  // index whenever two deliveries are created at the same moment.
  const id = randomUUID();
  const token = crypto.signScopedToken('recipient', id, expiresAt);
  await db.insert(deliveries).values({
    id,
    firmId: opts.firmId,
    formRecordId: opts.formRecordId,
    channel: opts.channel,
    tokenHash: crypto.tokenHash(token),
    tokenExpiresAt: expiresAt,
    isCorrected: opts.isCorrected,
  });
  return { deliveryId: id, token, expiresAt };
}

/**
 * Bulk composer: after batch accepted/printed, send portal links to recipients
 * with email/mobile on file. Courtesy-copy framing (policy b) in templates.
 */
deliveriesRouter.post(
  '/compose',
  h(async (req, res) => {
    const input = z
      .object({
        taxYear: zTaxYear,
        payerIds: z.array(z.string().uuid()).min(1),
        formRecordIds: z.array(z.string().uuid()).optional(),
        statuses: z.array(z.string()).default(['accepted', 'accepted_with_errors']),
      })
      .parse(req.body);
    const db = getDb();
    const firmId = req.staff!.firmId;
    const env = loadEnv();

    const conds = [
      eq(formRecords.firmId, firmId),
      eq(formRecords.taxYear, input.taxYear),
      inArray(formRecords.payerId, input.payerIds),
      inArray(formRecords.status, input.statuses as ['accepted']),
    ];
    if (input.formRecordIds?.length) conds.push(inArray(formRecords.id, input.formRecordIds));

    const rows = await db
      .select({ form: formRecords, recipient: recipients, payerName: payers.legalName })
      .from(formRecords)
      .innerJoin(recipients, eq(recipients.id, formRecords.recipientId))
      .innerJoin(payers, eq(payers.id, formRecords.payerId))
      .where(and(...conds));

    const firm = await db.query.firms.findFirst({ where: eq(firms.id, firmId) });
    // Re-running compose (double click, retry after a proxy timeout, a second
    // campaign) must not mail every recipient a SECOND live link: skip forms that
    // already have an un-revoked, un-expired delivery on a channel for the same
    // original/corrected version.
    const live = rows.length
      ? await db
          .select({ formRecordId: deliveries.formRecordId, channel: deliveries.channel, isCorrected: deliveries.isCorrected })
          .from(deliveries)
          .where(
            and(
              eq(deliveries.firmId, firmId),
              inArray(
                deliveries.formRecordId,
                rows.map((r) => r.form.id),
              ),
              inArray(deliveries.channel, ['email', 'sms']),
              isNull(deliveries.tokenRevokedAt),
              gt(deliveries.tokenExpiresAt, new Date()),
            ),
          )
      : [];
    const liveKeys = new Set(live.map((l) => `${l.formRecordId}:${l.isCorrected}`));
    const expiresAt = await tokenExpiry(input.taxYear); // identical for every row (same tax year)
    const jobs: DeliveryJob[] = [];
    let paperOnly = 0;
    let skipped = 0;
    for (const { form, recipient, payerName } of rows) {
      const isCorrected = form.correctionSeq > 0 || form.correctionType != null;
      // channel resolution: email preferred, SMS fallback (opt-out honored), none → paper-only
      const channel: 'email' | 'sms' | null = recipient.email
        ? 'email'
        : recipient.mobile && !recipient.smsOptOut
          ? 'sms'
          : null;
      if (!channel) {
        paperOnly++;
        continue;
      }
      if (liveKeys.has(`${form.id}:${isCorrected}`)) {
        skipped++;
        continue;
      }
      const { deliveryId, token } = await createPortalDelivery({
        firmId,
        formRecordId: form.id,
        channel,
        isCorrected,
        expiresAt,
      });
      const link = `${env.PORTAL_BASE_URL}/f/${encodeURIComponent(token)}`;
      jobs.push({
        kind: 'form_notification',
        channel,
        firmId,
        to: channel === 'email' ? (recipient.email as string) : (recipient.mobile as string),
        templateKey: isCorrected ? 'form_corrected' : 'form_available',
        vars: {
          taxYear: String(form.taxYear),
          formType: form.formType,
          payerName,
          firmName: firm?.name ?? '',
          link,
          expires: expiresAt.toISOString().slice(0, 10),
        },
        deliveryId,
      });
    }
    if (jobs.length) await getQueue(QUEUE_NAMES.delivery).addBulk(jobs.map((data) => ({ name: 'form_notification', data })));
    const queued = jobs.length;
    res.locals['audit'] = { action: 'delivery.compose', entityType: 'delivery', detail: { queued, paperOnly, skipped } };
    res.json({ queued, paperOnly, skipped });
  }),
);

/** Delivery status matrix per form/payer. */
deliveriesRouter.get(
  '/',
  h(async (req, res) => {
    const q = z
      .object({ formRecordId: z.string().uuid().optional(), payerId: z.string().uuid().optional(), taxYear: z.coerce.number().int().optional() })
      .parse(req.query);
    const db = getDb();
    const conds = [eq(deliveries.firmId, req.staff!.firmId)];
    if (q.formRecordId) conds.push(eq(deliveries.formRecordId, q.formRecordId));
    let rows;
    if (q.payerId || q.taxYear) {
      const fConds = [eq(formRecords.firmId, req.staff!.firmId)];
      if (q.payerId) fConds.push(eq(formRecords.payerId, q.payerId));
      if (q.taxYear) fConds.push(eq(formRecords.taxYear, q.taxYear));
      rows = await db
        .select({ d: deliveries })
        .from(deliveries)
        .innerJoin(formRecords, eq(formRecords.id, deliveries.formRecordId))
        .where(and(...conds, ...fConds))
        .orderBy(desc(deliveries.createdAt));
      rows = rows.map((r) => r.d);
    } else {
      rows = await db
        .select()
        .from(deliveries)
        .where(and(...conds))
        .orderBy(desc(deliveries.createdAt))
        .limit(500);
    }
    res.json({
      deliveries: rows.map((d) => ({
        id: d.id,
        formRecordId: d.formRecordId,
        channel: d.channel,
        isCorrected: d.isCorrected,
        sentAt: d.sentAt,
        bouncedAt: d.bouncedAt,
        viewedAt: d.viewedAt,
        downloadedAt: d.downloadedAt,
        failReason: d.failReason,
        tokenExpiresAt: d.tokenExpiresAt,
        tokenRevokedAt: d.tokenRevokedAt,
        paperBatchId: d.paperBatchId,
        createdAt: d.createdAt,
      })),
    });
  }),
);

/** Resend + regenerate token (invalidates old). */
deliveriesRouter.post(
  '/:id/resend',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const db = getDb();
    const env = loadEnv();
    const old = await db.query.deliveries.findFirst({ where: and(eq(deliveries.id, id), eq(deliveries.firmId, req.staff!.firmId)) });
    if (!old) throw AppError.notFound('Delivery');
    if (old.channel === 'paper') throw AppError.validation('Paper deliveries are reprinted via batches');

    const record = await db.query.formRecords.findFirst({ where: eq(formRecords.id, old.formRecordId) });
    const recipient = record ? await db.query.recipients.findFirst({ where: eq(recipients.id, record.recipientId) }) : null;
    const payer = record ? await db.query.payers.findFirst({ where: eq(payers.id, record.payerId) }) : null;
    const firm = await db.query.firms.findFirst({ where: eq(firms.id, req.staff!.firmId) });
    if (!record || !recipient || !payer) throw AppError.notFound('Form record');

    const to = old.channel === 'email' ? recipient.email : recipient.mobile;
    if (!to) throw AppError.validation(`Recipient has no ${old.channel} on file`);

    const { deliveryId, token, expiresAt } = await createPortalDelivery({
      firmId: req.staff!.firmId,
      formRecordId: old.formRecordId,
      channel: old.channel,
      isCorrected: old.isCorrected,
    });
    const job: DeliveryJob = {
      kind: 'form_notification',
      channel: old.channel,
      firmId: req.staff!.firmId,
      to,
      templateKey: old.isCorrected ? 'form_corrected' : 'form_available',
      vars: {
        taxYear: String(record.taxYear),
        formType: record.formType,
        payerName: payer.legalName,
        firmName: firm?.name ?? '',
        link: `${env.PORTAL_BASE_URL}/f/${encodeURIComponent(token)}`,
        expires: expiresAt.toISOString().slice(0, 10),
      },
      deliveryId,
    };
    await getQueue(QUEUE_NAMES.delivery).add('form_notification', job);
    // revoke the OLD token only once its replacement exists and is queued — a
    // resend that fails validation above must leave the recipient's working link alive
    await db.update(deliveries).set({ tokenRevokedAt: new Date() }).where(eq(deliveries.id, id));
    res.locals['audit'] = { action: 'delivery.resend', entityType: 'delivery', entityId: deliveryId, detail: { replaced: id } };
    res.json({ deliveryId });
  }),
);

deliveriesRouter.post(
  '/:id/revoke',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    await getDb()
      .update(deliveries)
      .set({ tokenRevokedAt: new Date() })
      .where(and(eq(deliveries.id, id), eq(deliveries.firmId, req.staff!.firmId)));
    res.locals['audit'] = { action: 'delivery.revoke', entityType: 'delivery', entityId: id };
    res.json({ ok: true });
  }),
);
