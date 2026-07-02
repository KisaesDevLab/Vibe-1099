/**
 * Client invites (Phase 5, staff side): magic-link generation, revoke/reissue,
 * review queue for client-submitted records, re-open flow.
 */
import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, zClientInviteInput } from '@vibe1099/shared';
import { getCrypto, getQueue, loadEnv, QUEUE_NAMES, type DeliveryJob } from '@vibe1099/core';
import { clientInvites, firms, formRecords, getDb, payers } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { requireStaff } from '../middleware/auth.js';
import { getSetting } from '../services/settings.js';
import { transitionStatus } from '../services/forms.js';

export const invitesRouter = Router();
invitesRouter.use(requireStaff());

async function issueInviteToken(inviteId: string, expiresAt: Date): Promise<string> {
  const crypto = getCrypto();
  const token = crypto.signScopedToken('client', inviteId, expiresAt);
  await getDb().update(clientInvites).set({ tokenHash: crypto.tokenHash(token) }).where(eq(clientInvites.id, inviteId));
  return token;
}

invitesRouter.get(
  '/',
  h(async (req, res) => {
    const q = z.object({ payerId: z.string().uuid().optional(), taxYear: z.coerce.number().int().optional() }).parse(req.query);
    const conds = [eq(clientInvites.firmId, req.staff!.firmId)];
    if (q.payerId) conds.push(eq(clientInvites.payerId, q.payerId));
    if (q.taxYear) conds.push(eq(clientInvites.taxYear, q.taxYear));
    const rows = await getDb()
      .select({
        invite: clientInvites,
        payerName: payers.legalName,
      })
      .from(clientInvites)
      .innerJoin(payers, eq(payers.id, clientInvites.payerId))
      .where(and(...conds))
      .orderBy(desc(clientInvites.createdAt));
    res.json({
      invites: rows.map(({ invite, payerName }) => ({
        id: invite.id,
        payerId: invite.payerId,
        payerName,
        taxYear: invite.taxYear,
        formTypes: invite.formTypes,
        email: invite.email,
        mobile: invite.mobile,
        expiresAt: invite.expiresAt,
        revokedAt: invite.revokedAt,
        submittedAt: invite.submittedAt,
        reopenedAt: invite.reopenedAt,
        lastActivityAt: invite.lastActivityAt,
        createdAt: invite.createdAt,
      })),
    });
  }),
);

invitesRouter.post(
  '/',
  h(async (req, res) => {
    const input = zClientInviteInput.parse(req.body);
    const db = getDb();
    const firmId = req.staff!.firmId;
    const payer = await db.query.payers.findFirst({ where: and(eq(payers.id, input.payerId), eq(payers.firmId, firmId)) });
    if (!payer) throw AppError.notFound('Payer');

    const expiryDays = input.expiresInDays ?? ((await getSetting<number>('invite_expiry_days')) ?? 30);
    const expiresAt = new Date(Date.now() + expiryDays * 86_400_000);

    const [created] = await db
      .insert(clientInvites)
      .values({
        firmId,
        payerId: input.payerId,
        taxYear: input.taxYear,
        formTypes: input.formTypes,
        tokenHash: 'pending',
        email: input.email ?? payer.contactEmail,
        mobile: input.mobile ?? payer.contactMobile,
        expiresAt,
        createdBy: req.staff!.userId,
      })
      .returning({ id: clientInvites.id });
    if (!created) throw new Error('invite insert failed');
    const token = await issueInviteToken(created.id, expiresAt);

    const env = loadEnv();
    const link = `${env.APP_BASE_URL}/client?token=${encodeURIComponent(token)}`;

    // send via email/SMS when contact info present
    const firm = await db.query.firms.findFirst({ where: eq(firms.id, firmId) });
    const vars = {
      firmName: firm?.name ?? 'Your accounting firm',
      payerName: payer.legalName,
      taxYear: String(input.taxYear),
      link,
      expires: expiresAt.toISOString().slice(0, 10),
    };
    const to = input.email ?? payer.contactEmail;
    const toMobile = input.mobile ?? payer.contactMobile;
    if (to) {
      const job: DeliveryJob = { kind: 'client_invite', channel: 'email', firmId, to, templateKey: 'client_invite', vars };
      await getQueue(QUEUE_NAMES.delivery).add('client_invite', job);
    }
    if (toMobile) {
      const job: DeliveryJob = { kind: 'client_invite', channel: 'sms', firmId, to: toMobile, templateKey: 'client_invite', vars };
      await getQueue(QUEUE_NAMES.delivery).add('client_invite', job);
    }

    res.locals['audit'] = { action: 'invite.create', entityType: 'client_invite', entityId: created.id };
    res.status(201).json({ id: created.id, link, expiresAt });
  }),
);

invitesRouter.post(
  '/:id/revoke',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    await getDb()
      .update(clientInvites)
      .set({ revokedAt: new Date() })
      .where(and(eq(clientInvites.id, id), eq(clientInvites.firmId, req.staff!.firmId)));
    res.locals['audit'] = { action: 'invite.revoke', entityType: 'client_invite', entityId: id };
    res.json({ ok: true });
  }),
);

invitesRouter.post(
  '/:id/reissue',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const db = getDb();
    const invite = await db.query.clientInvites.findFirst({
      where: and(eq(clientInvites.id, id), eq(clientInvites.firmId, req.staff!.firmId)),
    });
    if (!invite) throw AppError.notFound('Invite');
    const expiryDays = (await getSetting<number>('invite_expiry_days')) ?? 30;
    const expiresAt = new Date(Date.now() + expiryDays * 86_400_000);
    await db.update(clientInvites).set({ revokedAt: null, expiresAt }).where(eq(clientInvites.id, id));
    const token = await issueInviteToken(id, expiresAt);
    const env = loadEnv();
    res.locals['audit'] = { action: 'invite.reissue', entityType: 'client_invite', entityId: id };
    res.json({ link: `${env.APP_BASE_URL}/client?token=${encodeURIComponent(token)}`, expiresAt });
  }),
);

/** Re-open a submitted engagement for client edits. */
invitesRouter.post(
  '/:id/reopen',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    await getDb()
      .update(clientInvites)
      .set({ submittedAt: null, reopenedAt: new Date() })
      .where(and(eq(clientInvites.id, id), eq(clientInvites.firmId, req.staff!.firmId)));
    res.locals['audit'] = { action: 'invite.reopen', entityType: 'client_invite', entityId: id };
    res.json({ ok: true });
  }),
);

/** Staff review queue: client-submitted drafts, diff vs vault, promote to ready. */
invitesRouter.get(
  '/review-queue',
  h(async (req, res) => {
    const q = z.object({ taxYear: z.coerce.number().int().optional() }).parse(req.query);
    const conds = [
      eq(formRecords.firmId, req.staff!.firmId),
      eq(formRecords.clientSubmitted, true),
      eq(formRecords.status, 'draft'),
    ];
    if (q.taxYear) conds.push(eq(formRecords.taxYear, q.taxYear));
    const rows = await getDb()
      .select()
      .from(formRecords)
      .where(and(...conds))
      .orderBy(desc(formRecords.updatedAt));
    res.json({ queue: rows });
  }),
);

invitesRouter.post(
  '/review-queue/:formId/promote',
  h(async (req, res) => {
    const formId = z.string().uuid().parse(req.params['formId']);
    const reviewerGate = (await getSetting<boolean>('reviewer_gate_enabled')) ?? false;
    const updated = await transitionStatus(getDb(), req.staff!.firmId, formId, 'ready', {
      actorId: req.staff!.userId,
      actorRole: req.staff!.role,
      reviewerGateEnabled: reviewerGate,
    });
    res.locals['audit'] = { action: 'review.promote', entityType: 'form_record', entityId: formId };
    res.json({ form: updated });
  }),
);
