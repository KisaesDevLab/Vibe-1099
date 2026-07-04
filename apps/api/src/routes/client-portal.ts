/**
 * Client entry portal — PUBLIC routes (Phase 5). Client zone: magic-link token
 * scoped to (payer, tax_year). Scope enforcement lives at the query layer here;
 * clients NEVER see other payers/years/staff data, and vault matches are masked.
 */
import { Router } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { AppError, ErrorCodes, getFormDef, zRecipientInput, zTinType, type FormType } from '@vibe1099/shared';
import { audit } from '@vibe1099/core';
import { clientInvites, firms, formRecords, getDb, payers, recipients } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { CLIENT_COOKIE, requireClient } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { createRecipient, lookupByTin } from '../services/vault.js';
import { validateFormRecord } from '../services/forms.js';
import { isPortalOtpVerified, maskContact, portalOtpRequired, requestPortalOtp, verifyPortalOtp, type OtpChannel } from '../services/portal-otp.js';
import { loadEnv } from '@vibe1099/core';

export const clientPortalRouter = Router();
clientPortalRouter.use(rateLimit({ key: 'client-portal', limit: 120, windowSec: 60 }));
clientPortalRouter.use(requireClient());

async function touchActivity(inviteId: string): Promise<void> {
  await getDb().update(clientInvites).set({ lastActivityAt: new Date() }).where(eq(clientInvites.id, inviteId));
}

/** The client's reachable contact (from the payer record) for OTP delivery. */
async function clientContact(payerId: string): Promise<{ channel: OtpChannel; to: string } | null> {
  const payer = await getDb().query.payers.findFirst({ where: eq(payers.id, payerId) });
  if (payer?.contactEmail) return { channel: 'email', to: payer.contactEmail };
  if (payer?.contactMobile) return { channel: 'sms', to: payer.contactMobile };
  return null;
}
const clientOtpKey = (inviteId: string, sid: string) => `client:${inviteId}:${sid}`;

/** Gate the client's data behind a verified OTP when required + a contact exists. */
function requireClientOtp() {
  return h(async (req, res, next) => {
    const scope = req.clientScope!;
    if (!(await portalOtpRequired())) return next();
    const contact = await clientContact(scope.payerId);
    if (!contact) return next(); // no way to send a code — token-only fallback
    const sid = (req.cookies as Record<string, string>)[CLIENT_COOKIE];
    if (sid && (await isPortalOtpVerified(clientOtpKey(scope.inviteId, sid)))) return next();
    throw new AppError(ErrorCodes.E_CHALLENGE_FAILED, 'Verification code required', 403);
  });
}

/** Send a one-time code to the client's contact on file (binds to a browser cookie). */
clientPortalRouter.post(
  '/request-otp',
  rateLimit({ key: 'client-otp', limit: 6, windowSec: 300 }),
  h(async (req, res) => {
    const scope = req.clientScope!;
    const contact = await clientContact(scope.payerId);
    if (!contact) throw AppError.validation('No contact on file to send a code — ask your accountant.');
    let sid = (req.cookies as Record<string, string>)[CLIENT_COOKIE];
    if (!sid) {
      sid = randomUUID();
      const secure = loadEnv().NODE_ENV === 'production' && loadEnv().PORTAL_BASE_URL.startsWith('https');
      res.cookie(CLIENT_COOKIE, sid, { httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: 60 * 60 * 1000 });
    }
    const firm = await getDb().query.firms.findFirst({ where: eq(firms.id, scope.firmId) });
    const r = await requestPortalOtp(scope.firmId, firm?.name ?? 'your accountant', clientOtpKey(scope.inviteId, sid), contact);
    res.json({ sent: r.sent, throttled: !!r.throttled, sentTo: maskContact(contact.channel, contact.to), channel: contact.channel });
  }),
);

/** Verify the code. */
clientPortalRouter.post(
  '/verify-otp',
  rateLimit({ key: 'client-otp-verify', limit: 15, windowSec: 300 }),
  h(async (req, res) => {
    const scope = req.clientScope!;
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const sid = (req.cookies as Record<string, string>)[CLIENT_COOKIE];
    if (!sid) throw AppError.validation('Request a code first.');
    const result = await verifyPortalOtp(clientOtpKey(scope.inviteId, sid), code);
    if (result !== 'ok') throw new AppError(ErrorCodes.E_CHALLENGE_FAILED, result === 'locked' ? 'Too many attempts — request a new code.' : result === 'expired' ? 'Code expired — request a new one.' : 'Incorrect code.', 403);
    res.json({ verified: true });
  }),
);

/** Landing: payer confirmation, engagement scope, plain-language instructions. */
clientPortalRouter.get(
  '/session',
  h(async (req, res) => {
    const scope = req.clientScope!;
    const db = getDb();
    const [payer, firm, invite] = await Promise.all([
      db.query.payers.findFirst({ where: eq(payers.id, scope.payerId) }),
      db.query.firms.findFirst({ where: eq(firms.id, scope.firmId) }),
      db.query.clientInvites.findFirst({ where: eq(clientInvites.id, scope.inviteId) }),
    ]);
    if (!payer || !invite) throw AppError.notFound('Engagement');
    await touchActivity(scope.inviteId);
    // OTP gate status for the client (so the portal shows the code step first)
    const contact = await clientContact(scope.payerId);
    const otpRequired = (await portalOtpRequired()) && !!contact;
    const sid = (req.cookies as Record<string, string>)[CLIENT_COOKIE];
    const otpVerified = otpRequired && !!sid && (await isPortalOtpVerified(clientOtpKey(scope.inviteId, sid)));
    res.json({
      firmName: firm?.name ?? '',
      payerName: payer.legalName,
      taxYear: scope.taxYear,
      formTypes: scope.formTypes,
      otpRequired,
      otpVerified,
      otpContact: contact ? maskContact(contact.channel, contact.to) : null,
      submitted: !!invite.submittedAt,
      draftState: invite.draftState ?? null,
      registry: scope.formTypes.map((ft) => {
        const def = getFormDef(ft as FormType, scope.taxYear);
        return {
          formType: def.formType,
          title: def.title,
          boxes: def.boxes
            .filter((b) => !b.stateField)
            .map((b) => ({ id: b.id, boxNumber: b.boxNumber, label: b.label, kind: b.kind })),
        };
      }),
    });
  }),
);

// Everything below requires a verified OTP (when enabled + a contact exists).
clientPortalRouter.use(requireClientOtp());

/** Prior-year recipients pre-listed for the contractor grid. */
clientPortalRouter.get(
  '/contractors',
  h(async (req, res) => {
    const scope = req.clientScope!;
    const db = getDb();
    const prior = await db
      .selectDistinct({ recipientId: formRecords.recipientId })
      .from(formRecords)
      .where(and(eq(formRecords.payerId, scope.payerId), eq(formRecords.taxYear, scope.taxYear - 1)));
    // ALL current-year records for this payer (not just this invite) so the client
    // sees every recipient + amount already entered — including staff-entered and
    // already-filed forms, which come back locked.
    const current = await db
      .select()
      .from(formRecords)
      .where(and(eq(formRecords.payerId, scope.payerId), eq(formRecords.taxYear, scope.taxYear)));
    const ids = [...new Set([...prior.map((p) => p.recipientId), ...current.map((c) => c.recipientId)])];
    const recips = ids.length ? await db.select().from(recipients).where(inArray(recipients.id, ids)) : [];
    res.json({
      contractors: recips.map((r) => ({
        recipientId: r.id,
        name1: r.name1,
        name2: r.name2 ?? '',
        maskedAddress: `${(r.address['line1'] ?? '').slice(0, 12)}… ${r.address['city'] ?? ''}`,
        // full mailing address IS shown to the payer for their OWN contractors so
        // they can verify where Copy B is mailed. TIN stays truncated to last-4.
        address: {
          line1: r.address['line1'] ?? '',
          line2: r.address['line2'] ?? '',
          city: r.address['city'] ?? '',
          state: r.address['state'] ?? '',
          zip: r.address['zip'] ?? '',
        },
        email: r.email ?? '',
        mobile: r.mobile ?? '',
        tinType: r.tinType,
        tinLast4: r.tinLast4,
        w9Status: r.w9Status,
      })),
      entries: current.map((c) => ({
        formId: c.id,
        recipientId: c.recipientId,
        formType: c.formType,
        boxValues: c.boxValues,
        status: c.status,
        // "filed" for the client = anything staff has advanced past draft. These are
        // shown read-only; the client cannot change or re-submit an amount once filed.
        filed: c.status !== 'draft',
      })),
    });
  }),
);

/**
 * Substitute Copy B for a FILED form — client can print their contractors' 1099s.
 * Scoped hard to (payer, tax year); only filed forms; both TINs truncated.
 */
clientPortalRouter.get(
  '/forms/:formId/copy-b',
  h(async (req, res) => {
    const scope = req.clientScope!;
    const formId = z.string().uuid().parse(req.params['formId']);
    const db = getDb();
    const form = await db.query.formRecords.findFirst({ where: eq(formRecords.id, formId) });
    // must belong to THIS engagement's payer + year, and actually be filed
    if (!form || form.payerId !== scope.payerId || form.taxYear !== scope.taxYear) {
      throw AppError.notFound('Form');
    }
    if (form.status === 'draft') {
      throw AppError.state('This 1099 has not been filed yet — a copy is available once your accountant files it.');
    }
    const { renderSubstitutePdf } = await import('../services/render.js');
    const pdf = await renderSubstitutePdf(db, scope.firmId, formId);
    await touchActivity(scope.inviteId);
    await audit(db, {
      firmId: scope.firmId,
      actorType: 'client',
      actorId: scope.inviteId,
      action: 'client.form.print',
      entityType: 'form_record',
      entityId: formId,
      ip: req.ip,
    });
    res.setHeader('content-disposition', `attachment; filename="1099-${form.formType}-${scope.taxYear}.pdf"`);
    res.type('application/pdf').send(pdf);
  }),
);

/** Client-side TIN lookup → masked confirm/update flow. */
clientPortalRouter.post(
  '/lookup',
  h(async (req, res) => {
    const { tin, tinType } = z.object({ tin: z.string().min(9).max(11), tinType: zTinType }).parse(req.body);
    const scope = req.clientScope!;
    const match = await lookupByTin(getDb(), scope.firmId, tin, tinType, { payerId: scope.payerId });
    await touchActivity(scope.inviteId);
    if (!match) return void res.json({ match: null });
    // masked echo: "We have JOHN D— at 123 M— St — is this current?"
    const maskName = (n: string) => {
      const parts = n.split(/\s+/);
      return parts.map((p, i) => (i === parts.length - 1 && parts.length > 1 ? `${p[0] ?? ''}—` : p)).join(' ');
    };
    const line1 = match.address['line1'] ?? '';
    res.json({
      match: {
        recipientId: match.recipientId,
        maskedName: maskName(match.name1),
        maskedAddress: `${line1.split(/\s+/).slice(0, 2).join(' ')}— ${match.address['city'] ?? ''}`,
        w9Status: match.w9Status,
      },
    });
  }),
);

/** Add a new contractor (client zone) — lands in the vault flagged client-created. */
clientPortalRouter.post(
  '/contractors',
  h(async (req, res) => {
    const scope = req.clientScope!;
    const input = zRecipientInput.parse(req.body);
    const result = await createRecipient(getDb(), scope.firmId, input, {
      source: 'client',
      onExisting: 'return', // never leak or overwrite existing vault data from client zone
    });
    await touchActivity(scope.inviteId);
    await audit(getDb(), {
      firmId: scope.firmId,
      actorType: 'client',
      actorId: scope.inviteId,
      action: 'client.contractor.add',
      entityType: 'recipient',
      entityId: result.id,
      ip: req.ip,
    });
    res.status(201).json({ recipientId: result.id, existed: result.existed });
  }),
);

/** Client-initiated W-9 request ("don't have their TIN?" button — Phase 7). */
clientPortalRouter.post(
  '/w9-request',
  h(async (req, res) => {
    const scope = req.clientScope!;
    const { name, email, mobile } = z
      .object({ name: z.string().max(120).default(''), email: z.string().email().optional().nullable(), mobile: z.string().optional().nullable() })
      .parse(req.body);
    const { createW9Request } = await import('./w9.js');
    const result = await createW9Request({
      firmId: scope.firmId,
      payerId: scope.payerId,
      requestedName: name,
      email: email ?? null,
      mobile: mobile ?? null,
      requestedVia: 'client',
    });
    await touchActivity(scope.inviteId);
    res.status(201).json({ id: result.id });
  }),
);

/** Save draft (save-and-return). */
clientPortalRouter.put(
  '/draft',
  h(async (req, res) => {
    const scope = req.clientScope!;
    const { draftState } = z.object({ draftState: z.record(z.unknown()) }).parse(req.body);
    const invite = await getDb().query.clientInvites.findFirst({ where: eq(clientInvites.id, scope.inviteId) });
    if (invite?.submittedAt) throw AppError.state('Engagement already submitted — ask your accountant to re-open it');
    await getDb()
      .update(clientInvites)
      .set({ draftState: draftState as Record<string, unknown>, lastActivityAt: new Date() })
      .where(eq(clientInvites.id, scope.inviteId));
    res.json({ ok: true });
  }),
);

/** Submit: entries land as draft records flagged client_submitted → staff review queue. */
clientPortalRouter.post(
  '/submit',
  h(async (req, res) => {
    const scope = req.clientScope!;
    const { entries } = z
      .object({
        entries: z
          .array(
            z.object({
              recipientId: z.string().uuid(),
              formType: z.string(),
              boxValues: z.record(z.union([z.number().int(), z.boolean(), z.string(), z.null()])),
            }),
          )
          .min(1)
          .max(1000),
      })
      .parse(req.body);

    const db = getDb();
    const invite = await db.query.clientInvites.findFirst({ where: eq(clientInvites.id, scope.inviteId) });
    if (!invite) throw AppError.notFound('Engagement');
    if (invite.submittedAt) throw AppError.state('Already submitted');

    // scope enforcement: only staff-enabled form types
    for (const e of entries) {
      if (!scope.formTypes.includes(e.formType)) {
        throw AppError.forbidden(`Form type ${e.formType} is not enabled for this engagement`);
      }
    }

    // replace this invite's previous entries (client edits before submit)
    await db
      .delete(formRecords)
      .where(
        and(
          eq(formRecords.clientInviteId, scope.inviteId),
          eq(formRecords.status, 'draft'),
          eq(formRecords.clientSubmitted, true),
        ),
      );

    const created: string[] = [];
    const issuesByEntry: Array<{ index: number; issues: unknown[] }> = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const issues = await validateFormRecord(db, scope.firmId, {
        formType: e.formType as FormType,
        taxYear: scope.taxYear,
        boxValues: e.boxValues,
        recipientId: e.recipientId,
        secondTinNotice: false,
      });
      const errors = issues.filter((x) => x.severity === 'error');
      if (errors.length) {
        issuesByEntry.push({ index: i, issues: errors });
        continue;
      }
      const [row] = await db
        .insert(formRecords)
        .values({
          firmId: scope.firmId,
          payerId: scope.payerId,
          recipientId: e.recipientId,
          taxYear: scope.taxYear,
          formType: e.formType as FormType,
          boxValues: e.boxValues as Record<string, number | boolean | string | null>,
          clientSubmitted: true,
          clientInviteId: scope.inviteId,
          moSource: false,
        })
        .returning({ id: formRecords.id });
      if (row) created.push(row.id);
    }

    if (issuesByEntry.length) {
      // reject atomically-ish: remove created rows, surface validation report
      if (created.length) await db.delete(formRecords).where(inArray(formRecords.id, created));
      throw AppError.validation('Some entries have errors', issuesByEntry);
    }

    await db
      .update(clientInvites)
      .set({ submittedAt: new Date(), lastActivityAt: new Date(), draftState: null })
      .where(eq(clientInvites.id, scope.inviteId));

    await audit(db, {
      firmId: scope.firmId,
      actorType: 'client',
      actorId: scope.inviteId,
      action: 'client.submit',
      entityType: 'client_invite',
      entityId: scope.inviteId,
      detail: { entryCount: created.length },
      ip: req.ip,
    });

    res.json({ ok: true, created: created.length });
  }),
);
