/**
 * Recipient portal — PUBLIC (Phase 8). Token link → last-4 TIN challenge →
 * view/download Copy B PDF. Abuse controls: 5-attempt lockout with staff alert,
 * per-IP throttle. Single-resource scope (T&B third-party-share pattern).
 */
import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, ErrorCodes } from '@vibe1099/shared';
import { audit, getQueue, getRedis, QUEUE_NAMES, type DeliveryJob } from '@vibe1099/core';
import { deliveries, firms, formRecords, getDb, payers, recipients, users } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { requireChallengePassed, requireRecipientToken } from '../middleware/auth.js';
import { checkLockout, clearFailures, rateLimit, recordFailure } from '../middleware/rate-limit.js';
import { renderPortalPdf } from '../services/render.js';

export const recipientPortalRouter = Router();
recipientPortalRouter.use(rateLimit({ key: 'recipient-portal', limit: 30, windowSec: 60 }));

/** Landing: minimal info before the challenge (never a name, never a TIN). */
recipientPortalRouter.get(
  '/:token',
  requireRecipientToken(),
  h(async (req, res) => {
    const scope = req.recipientScope!;
    const db = getDb();
    const record = await db.query.formRecords.findFirst({ where: eq(formRecords.id, scope.formRecordId) });
    const firm = await db.query.firms.findFirst({ where: eq(firms.id, scope.firmId) });
    res.json({
      firmName: firm?.name ?? '',
      taxYear: record?.taxYear,
      formType: record?.formType,
      challengePassed: scope.challengePassed,
    });
  }),
);

/** Identity challenge: last-4 of TIN, 5-attempt lockout, lockout alert to staff. */
recipientPortalRouter.post(
  '/:token/challenge',
  requireRecipientToken(),
  h(async (req, res) => {
    const scope = req.recipientScope!;
    const { last4 } = z.object({ last4: z.string().regex(/^\d{4}$/) }).parse(req.body);
    const lockKey = `recip:${scope.deliveryId}`;
    await checkLockout(lockKey, 5, 3600);

    const db = getDb();
    const recipient = await db.query.recipients.findFirst({ where: eq(recipients.id, scope.recipientId) });
    if (!recipient) throw AppError.notFound('Form');

    if (recipient.tinLast4 !== last4) {
      const attempts = await recordFailure(lockKey, 3600);
      if (attempts >= 5) {
        // lockout alert to staff (admin emails)
        const admins = await db.query.users.findMany({ where: eq(users.firmId, scope.firmId) });
        for (const admin of admins.filter((u) => u.role === 'admin' && u.active)) {
          const job: DeliveryJob = {
            kind: 'staff_alert',
            channel: 'email',
            firmId: scope.firmId,
            to: admin.email,
            templateKey: 'staff_alert',
            vars: {
              subject: 'Recipient portal lockout',
              message: `A recipient portal link (delivery ${scope.deliveryId}) was locked out after 5 failed identity attempts from IP ${req.ip ?? 'unknown'}.`,
            },
          };
          await getQueue(QUEUE_NAMES.delivery).add('staff_alert', job);
        }
        await audit(db, {
          firmId: scope.firmId,
          actorType: 'recipient',
          actorId: scope.deliveryId,
          action: 'recipient.lockout',
          entityType: 'delivery',
          entityId: scope.deliveryId,
          ip: req.ip,
        });
      }
      throw new AppError(ErrorCodes.E_CHALLENGE_FAILED, 'That does not match our records', 403, {
        attemptsRemaining: Math.max(0, 5 - attempts),
      });
    }

    await clearFailures(lockKey);
    await getRedis().set(`recip-ok:${scope.deliveryId}`, '1', 'EX', 30 * 60); // 30-min verified window

    // first successful view marks viewed_at
    const db2 = getDb();
    const delivery = await db2.query.deliveries.findFirst({ where: eq(deliveries.id, scope.deliveryId) });
    if (delivery && !delivery.viewedAt) {
      await db2.update(deliveries).set({ viewedAt: new Date() }).where(eq(deliveries.id, scope.deliveryId));
    }
    res.json({ ok: true });
  }),
);

/** Form metadata after challenge. */
recipientPortalRouter.get(
  '/:token/form',
  requireRecipientToken(),
  requireChallengePassed(),
  h(async (req, res) => {
    const scope = req.recipientScope!;
    const db = getDb();
    const record = await db.query.formRecords.findFirst({ where: eq(formRecords.id, scope.formRecordId) });
    if (!record) throw AppError.notFound('Form');
    const payer = await db.query.payers.findFirst({ where: eq(payers.id, record.payerId) });
    const isCorrected = record.correctionSeq > 0 || record.correctionType != null;
    res.json({
      taxYear: record.taxYear,
      formType: record.formType,
      payerName: payer?.legalName ?? '',
      corrected: isCorrected,
      // courtesy-copy framing (delivery policy b)
      note: 'Your paper copy has been mailed. This portal copy is provided for your convenience.',
    });
  }),
);

/** Copy B PDF download — the ONLY resource this token can reach. */
recipientPortalRouter.get(
  '/:token/pdf',
  requireRecipientToken(),
  requireChallengePassed(),
  h(async (req, res) => {
    const scope = req.recipientScope!;
    const db = getDb();
    const pdf = await renderPortalPdf(db, scope.firmId, scope.formRecordId);
    await db.update(deliveries).set({ downloadedAt: new Date() }).where(eq(deliveries.id, scope.deliveryId));
    await audit(db, {
      firmId: scope.firmId,
      actorType: 'recipient',
      actorId: scope.deliveryId,
      action: 'recipient.download',
      entityType: 'form_record',
      entityId: scope.formRecordId,
      ip: req.ip,
    });
    res.setHeader('content-disposition', 'attachment; filename="form1099.pdf"');
    res.type('application/pdf').send(pdf);
  }),
);
