/**
 * Recipient portal — PUBLIC (Phase 8). Token link → last-4 TIN challenge →
 * view/download Copy B PDF. Abuse controls: 5-attempt lockout with staff alert,
 * per-IP throttle. Single-resource scope (T&B third-party-share pattern).
 */
import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, ErrorCodes } from '@vibe1099/shared';
import { audit, getCrypto, getQueue, getRedis, loadEnv, QUEUE_NAMES, safeHexEqual, type DeliveryJob } from '@vibe1099/core';
import { deliveries, firms, formRecords, getDb, payers, recipients, users } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { RECIPIENT_COOKIE, recipientChallengeKey, requireChallengePassed, requireRecipientToken } from '../middleware/auth.js';
import { checkLockout, clearFailures, rateLimit, recordFailure } from '../middleware/rate-limit.js';
import { renderPortalPdf } from '../services/render.js';
import { isPortalOtpVerified, maskContact, portalOtpRequired, requestPortalOtp, verifyPortalOtp, type OtpChannel } from '../services/portal-otp.js';

/** The recipient's reachable contact for OTP delivery (email preferred). */
async function recipientContact(recipientId: string): Promise<{ channel: OtpChannel; to: string } | null> {
  const r = await getDb().query.recipients.findFirst({ where: eq(recipients.id, recipientId) });
  if (r?.email) return { channel: 'email', to: r.email };
  if (r?.mobile) return { channel: 'sms', to: r.mobile };
  return null;
}
const recipOtpKey = (deliveryId: string, sid: string) => `recip-otp:${deliveryId}:${sid}`;

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
    const contact = await recipientContact(scope.recipientId);
    const otpRequired = (await portalOtpRequired()) && !!contact;
    res.json({
      firmName: firm?.name ?? '',
      taxYear: record?.taxYear,
      formType: record?.formType,
      challengePassed: scope.challengePassed,
      otpRequired,
      otpContact: contact ? maskContact(contact.channel, contact.to) : null,
    });
  }),
);

/** Send a one-time code to the recipient's email/SMS (binds to a browser cookie). */
recipientPortalRouter.post(
  '/:token/request-otp',
  requireRecipientToken(),
  rateLimit({ key: 'recip-otp', limit: 6, windowSec: 300 }),
  h(async (req, res) => {
    const scope = req.recipientScope!;
    const contact = await recipientContact(scope.recipientId);
    if (!contact) throw AppError.validation('No contact on file to send a code.');
    let sid = (req.cookies as Record<string, string>)[RECIPIENT_COOKIE];
    if (!sid) {
      sid = getCrypto().newToken(24);
      const env = loadEnv();
      const secure = env.NODE_ENV === 'production' && env.PORTAL_BASE_URL.startsWith('https');
      res.cookie(RECIPIENT_COOKIE, sid, { httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: 60 * 60 * 1000 });
    }
    const firm = await getDb().query.firms.findFirst({ where: eq(firms.id, scope.firmId) });
    const r = await requestPortalOtp(scope.firmId, firm?.name ?? 'your sender', recipOtpKey(scope.deliveryId, sid), contact);
    res.json({ sent: r.sent, throttled: !!r.throttled, sentTo: maskContact(contact.channel, contact.to), channel: contact.channel });
  }),
);

/** Identity challenge: last-4 of TIN, 5-attempt lockout, lockout alert to staff. */
recipientPortalRouter.post(
  '/:token/challenge',
  requireRecipientToken(),
  h(async (req, res) => {
    const scope = req.recipientScope!;
    const { last4, code } = z.object({ last4: z.string().regex(/^\d{4}$/), code: z.string().regex(/^\d{6}$/).optional() }).parse(req.body);
    const lockKey = `recip:${scope.deliveryId}`;
    await checkLockout(lockKey, 5, 3600);

    const db = getDb();
    const recipient = await db.query.recipients.findFirst({ where: eq(recipients.id, scope.recipientId) });
    if (!recipient) throw AppError.notFound('Form');

    if (!safeHexEqual(recipient.tinLast4, last4)) {
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

    // Second factor: a one-time code sent to the recipient's email/SMS on file.
    // The click-token + last-4 alone are not sufficient — require the code too
    // (bound to THIS browser's request-otp session) when a contact exists.
    const contact = await recipientContact(scope.recipientId);
    const otpRequired = (await portalOtpRequired()) && !!contact;
    // reuse the browser session established at request-otp (needed for OTP binding)
    let recipSid = (req.cookies as Record<string, string>)[RECIPIENT_COOKIE];
    if (otpRequired) {
      if (!code) throw new AppError(ErrorCodes.E_CHALLENGE_FAILED, 'Enter the verification code sent to you', 403, { needCode: true });
      if (!recipSid) throw new AppError(ErrorCodes.E_CHALLENGE_FAILED, 'Request a verification code first', 403, { needCode: true });
      const r = await verifyPortalOtp(recipOtpKey(scope.deliveryId, recipSid), code);
      if (r !== 'ok') {
        throw new AppError(ErrorCodes.E_CHALLENGE_FAILED, r === 'locked' ? 'Too many code attempts — request a new code' : r === 'expired' ? 'Code expired — request a new one' : 'Incorrect code', 403, { needCode: true });
      }
    }

    // bind the 30-min verified window to an HttpOnly session cookie so only THIS
    // browser (not any holder of the URL token) rides the passed challenge
    const env = loadEnv();
    const secure = env.NODE_ENV === 'production' && env.PORTAL_BASE_URL.startsWith('https');
    if (!recipSid) {
      recipSid = getCrypto().newToken(24);
      res.cookie(RECIPIENT_COOKIE, recipSid, { httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: 30 * 60 * 1000 });
    }
    await getRedis().set(recipientChallengeKey(scope.deliveryId, recipSid), '1', 'EX', 30 * 60);

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
