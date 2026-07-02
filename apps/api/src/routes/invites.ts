/**
 * Client invites (Phase 5, staff side): magic-link generation, revoke/reissue,
 * review queue for client-submitted records, re-open flow.
 */
import { Router } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, zClientInviteInput } from '@vibe1099/shared';
import { getCrypto, getQueue, loadEnv, notify, QUEUE_NAMES, type DeliveryJob } from '@vibe1099/core';
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

/** Create + send one invite (shared by single and bulk). */
async function createAndSendInvite(opts: {
  firmId: string;
  payerId: string;
  taxYear: number;
  formTypes: string[];
  createdBy: string;
  email?: string | null;
  mobile?: string | null;
  expiryDays: number;
}): Promise<{ id: string; link: string; expiresAt: Date; sentEmail: boolean; sentSms: boolean }> {
  const db = getDb();
  const payer = await db.query.payers.findFirst({ where: and(eq(payers.id, opts.payerId), eq(payers.firmId, opts.firmId)) });
  if (!payer) throw AppError.notFound('Payer');
  const expiresAt = new Date(Date.now() + opts.expiryDays * 86_400_000);
  const [created] = await db
    .insert(clientInvites)
    .values({
      firmId: opts.firmId,
      payerId: opts.payerId,
      taxYear: opts.taxYear,
      formTypes: opts.formTypes,
      tokenHash: 'pending',
      email: opts.email ?? payer.contactEmail,
      mobile: opts.mobile ?? payer.contactMobile,
      expiresAt,
      createdBy: opts.createdBy,
    })
    .returning({ id: clientInvites.id });
  if (!created) throw new Error('invite insert failed');
  const token = await issueInviteToken(created.id, expiresAt);
  const env = loadEnv();
  const link = `${env.APP_BASE_URL}/client?token=${encodeURIComponent(token)}`;
  const firm = await db.query.firms.findFirst({ where: eq(firms.id, opts.firmId) });
  const vars = {
    firmName: firm?.name ?? 'Your accounting firm',
    payerName: payer.legalName,
    taxYear: String(opts.taxYear),
    link,
    expires: expiresAt.toISOString().slice(0, 10),
  };
  const to = opts.email ?? payer.contactEmail;
  const toMobile = opts.mobile ?? payer.contactMobile;
  if (to) await getQueue(QUEUE_NAMES.delivery).add('client_invite', { kind: 'client_invite', channel: 'email', firmId: opts.firmId, to, templateKey: 'client_invite', vars } as DeliveryJob);
  if (toMobile) await getQueue(QUEUE_NAMES.delivery).add('client_invite', { kind: 'client_invite', channel: 'sms', firmId: opts.firmId, to: toMobile, templateKey: 'client_invite', vars } as DeliveryJob);
  return { id: created.id, link, expiresAt, sentEmail: !!to, sentSms: !!toMobile };
}

invitesRouter.post(
  '/',
  h(async (req, res) => {
    const input = zClientInviteInput.parse(req.body);
    const expiryDays = input.expiresInDays ?? ((await getSetting<number>('invite_expiry_days')) ?? 30);
    const r = await createAndSendInvite({
      firmId: req.staff!.firmId,
      payerId: input.payerId,
      taxYear: input.taxYear,
      formTypes: input.formTypes,
      createdBy: req.staff!.userId,
      email: input.email,
      mobile: input.mobile,
      expiryDays,
    });
    res.locals['audit'] = { action: 'invite.create', entityType: 'client_invite', entityId: r.id };
    res.status(201).json({ id: r.id, link: r.link, expiresAt: r.expiresAt });
  }),
);

/**
 * Bulk invite campaign: invite many payers at once (default form types come from
 * each payer's preset). Kicks off a 100-client season in one action.
 */
invitesRouter.post(
  '/bulk',
  h(async (req, res) => {
    const input = z
      .object({
        payerIds: z.array(z.string().uuid()).min(1).max(1000),
        taxYear: z.number().int(),
        formTypes: z.array(z.enum(['NEC', 'MISC', 'INT', 'DIV'])).optional(), // override presets
        onlyUninvited: z.boolean().default(true),
      })
      .parse(req.body);
    const db = getDb();
    const firmId = req.staff!.firmId;
    const expiryDays = (await getSetting<number>('invite_expiry_days')) ?? 30;

    // skip payers already invited this year (unless overridden)
    let payerIds = input.payerIds;
    if (input.onlyUninvited) {
      const existing = await db
        .select({ payerId: clientInvites.payerId })
        .from(clientInvites)
        .where(and(eq(clientInvites.firmId, firmId), eq(clientInvites.taxYear, input.taxYear)));
      const invited = new Set(existing.map((e) => e.payerId));
      payerIds = payerIds.filter((p) => !invited.has(p));
    }
    const payerRows = await db.select().from(payers).where(and(eq(payers.firmId, firmId), inArray(payers.id, payerIds)));
    const pmap = new Map(payerRows.map((p) => [p.id, p]));

    const results: Array<{ payerId: string; payerName: string; ok: boolean; sentEmail?: boolean; sentSms?: boolean; message?: string }> = [];
    for (const payerId of payerIds) {
      const payer = pmap.get(payerId);
      if (!payer) { results.push({ payerId, payerName: payerId, ok: false, message: 'payer not found' }); continue; }
      const formTypes = input.formTypes ?? (payer.defaultFormTypes.length ? payer.defaultFormTypes : ['NEC']);
      try {
        const r = await createAndSendInvite({ firmId, payerId, taxYear: input.taxYear, formTypes, createdBy: req.staff!.userId, expiryDays });
        results.push({ payerId, payerName: payer.legalName, ok: true, sentEmail: r.sentEmail, sentSms: r.sentSms, message: !r.sentEmail && !r.sentSms ? 'no contact on file — link generated only' : undefined });
      } catch (err) {
        results.push({ payerId, payerName: payer.legalName, ok: false, message: (err as Error).message });
      }
    }
    const sent = results.filter((r) => r.ok).length;
    const noContact = results.filter((r) => r.ok && !r.sentEmail && !r.sentSms).length;
    await notify(db, {
      firmId,
      kind: 'invite',
      severity: 'success',
      title: 'Invite campaign sent',
      body: `${sent} invite(s) created${noContact ? `, ${noContact} had no contact on file` : ''}.`,
      link: '/invites',
    });
    res.locals['audit'] = { action: 'invite.bulk', entityType: 'client_invite', detail: { sent, requested: input.payerIds.length } };
    res.json({ sent, skipped: input.payerIds.length - payerIds.length, noContact, results });
  }),
);

/** Resend to every outstanding (not-submitted, not-revoked) invite for a year. */
invitesRouter.post(
  '/resend-outstanding',
  h(async (req, res) => {
    const { taxYear } = z.object({ taxYear: z.number().int() }).parse(req.body);
    const db = getDb();
    const firmId = req.staff!.firmId;
    const rows = await db
      .select({ invite: clientInvites, payer: payers })
      .from(clientInvites)
      .innerJoin(payers, eq(payers.id, clientInvites.payerId))
      .where(and(eq(clientInvites.firmId, firmId), eq(clientInvites.taxYear, taxYear)));
    const outstanding = rows.filter(({ invite }) => !invite.submittedAt && !invite.revokedAt);
    const env = loadEnv();
    const firm = await db.query.firms.findFirst({ where: eq(firms.id, firmId) });
    let resent = 0;
    for (const { invite, payer } of outstanding) {
      const expiresAt = new Date(Date.now() + ((await getSetting<number>('invite_expiry_days')) ?? 30) * 86_400_000);
      await db.update(clientInvites).set({ expiresAt }).where(eq(clientInvites.id, invite.id));
      const token = await issueInviteToken(invite.id, expiresAt);
      const vars = {
        firmName: firm?.name ?? '',
        payerName: payer.legalName,
        taxYear: String(taxYear),
        link: `${env.APP_BASE_URL}/client?token=${encodeURIComponent(token)}`,
        expires: expiresAt.toISOString().slice(0, 10),
      };
      const to = invite.email ?? payer.contactEmail;
      if (to) { await getQueue(QUEUE_NAMES.delivery).add('client_invite', { kind: 'client_invite', channel: 'email', firmId, to, templateKey: 'client_invite', vars } as DeliveryJob); resent++; }
    }
    res.locals['audit'] = { action: 'invite.resend-outstanding', entityType: 'client_invite', detail: { resent } };
    res.json({ outstanding: outstanding.length, resent });
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
