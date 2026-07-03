/**
 * W-9 request & collection (Phase 7).
 * Staff router: create requests, dashboard, resend, stale sweep, PDF retrieval.
 * Public router: tokenized W-9 form open/submit with e-sign capture.
 */
import { Router } from 'express';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, ErrorCodes, maskTin, normalizeTin, zW9RequestInput, zW9SubmitInput } from '@vibe1099/shared';
import { audit, getBlob, getCrypto, getQueue, getRenderClient, loadEnv, notify, putBlob, QUEUE_NAMES, safeHexEqual, type DeliveryJob } from '@vibe1099/core';
import { firms, formRecords, getDb, recipients, w9Requests } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { requireStaff } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { checkTin, createRecipient, lookupByTin, updateRecipient } from '../services/vault.js';
import { getSetting } from '../services/settings.js';

const W9_EXPIRY_DAYS = 30;

const TAX_CLASS_LABELS: Record<string, string> = {
  individual: 'Individual/sole proprietor',
  c_corp: 'C corporation',
  s_corp: 'S corporation',
  partnership: 'Partnership',
  trust_estate: 'Trust/estate',
  llc_c: 'LLC — C corporation',
  llc_s: 'LLC — S corporation',
  llc_p: 'LLC — Partnership',
  other: 'Other',
};

// ---------------------------------------------------------------------------
// staff router
// ---------------------------------------------------------------------------

export const w9StaffRouter = Router();
w9StaffRouter.use(requireStaff());

export async function createW9Request(opts: {
  firmId: string;
  recipientId?: string | null;
  payerId?: string | null;
  requestedName?: string;
  email?: string | null;
  mobile?: string | null;
  requestedBy?: string | null;
  requestedVia: 'staff' | 'client';
}): Promise<{ id: string; link: string }> {
  const db = getDb();
  const crypto = getCrypto();
  const env = loadEnv();

  if (!opts.email && !opts.mobile) throw AppError.validation('An email or mobile number is required to send a W-9 request');

  const expiresAt = new Date(Date.now() + W9_EXPIRY_DAYS * 86_400_000);
  const [created] = await db
    .insert(w9Requests)
    .values({
      firmId: opts.firmId,
      recipientId: opts.recipientId ?? null,
      payerId: opts.payerId ?? null,
      requestedName: opts.requestedName ?? '',
      email: opts.email ?? null,
      mobile: opts.mobile ?? null,
      tokenHash: 'pending',
      expiresAt,
      requestedBy: opts.requestedBy ?? null,
      requestedVia: opts.requestedVia,
    })
    .returning({ id: w9Requests.id });
  if (!created) throw new Error('w9 insert failed');

  const token = crypto.signScopedToken('w9', created.id, expiresAt);
  await db.update(w9Requests).set({ tokenHash: crypto.tokenHash(token) }).where(eq(w9Requests.id, created.id));

  if (opts.recipientId) {
    // mark requested from either 'none' or 'stale' so a campaign doesn't re-select
    // the same recipient forever
    await db
      .update(recipients)
      .set({ w9Status: 'requested', updatedAt: new Date() })
      .where(and(eq(recipients.id, opts.recipientId), inArray(recipients.w9Status, ['none', 'stale'])));
  }

  const link = `${env.PORTAL_BASE_URL}/w9/${encodeURIComponent(token)}`;
  const firm = await db.query.firms.findFirst({ where: eq(firms.id, opts.firmId) });
  const vars = {
    firmName: firm?.name ?? 'Accounting firm',
    requesterName: firm?.name ?? 'Your accounting firm',
    link,
    expires: expiresAt.toISOString().slice(0, 10),
  };
  if (opts.email) {
    const job: DeliveryJob = { kind: 'w9_request', channel: 'email', firmId: opts.firmId, to: opts.email, templateKey: 'w9_request', vars, w9RequestId: created.id };
    await getQueue(QUEUE_NAMES.delivery).add('w9_request', job);
  }
  if (opts.mobile) {
    const job: DeliveryJob = { kind: 'w9_request', channel: 'sms', firmId: opts.firmId, to: opts.mobile, templateKey: 'w9_request', vars, w9RequestId: created.id };
    await getQueue(QUEUE_NAMES.delivery).add('w9_request', job);
  }
  return { id: created.id, link };
}

w9StaffRouter.post(
  '/requests',
  h(async (req, res) => {
    const input = zW9RequestInput.parse(req.body);
    const result = await createW9Request({
      firmId: req.staff!.firmId,
      recipientId: input.recipientId,
      payerId: input.payerId,
      requestedName: input.name,
      email: input.email,
      mobile: input.mobile,
      requestedBy: req.staff!.userId,
      requestedVia: 'staff',
    });
    res.locals['audit'] = { action: 'w9.request', entityType: 'w9_request', entityId: result.id };
    res.status(201).json(result);
  }),
);

/** Dashboard: outstanding requests with aging. */
w9StaffRouter.get(
  '/requests',
  h(async (req, res) => {
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    const conds = [eq(w9Requests.firmId, req.staff!.firmId)];
    if (q.status) conds.push(eq(w9Requests.status, q.status as 'sent'));
    const rows = await getDb()
      .select({
        req: w9Requests,
        recipientName: recipients.name1,
        ageDays: sql<number>`EXTRACT(day FROM now() - ${w9Requests.createdAt})::int`,
      })
      .from(w9Requests)
      .leftJoin(recipients, eq(recipients.id, w9Requests.recipientId))
      .where(and(...conds))
      .orderBy(desc(w9Requests.createdAt));
    res.json({
      requests: rows.map(({ req: r, recipientName, ageDays }) => ({
        id: r.id,
        recipientId: r.recipientId,
        recipientName: recipientName ?? r.requestedName,
        email: r.email,
        mobile: r.mobile,
        status: r.status,
        ageDays,
        remindersSent: r.remindersSent,
        tinMismatch: r.tinMismatch,
        expiresAt: r.expiresAt,
        completedAt: r.completedAt,
        createdAt: r.createdAt,
      })),
    });
  }),
);

w9StaffRouter.post(
  '/requests/:id/resend',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const db = getDb();
    const row = await db.query.w9Requests.findFirst({ where: and(eq(w9Requests.id, id), eq(w9Requests.firmId, req.staff!.firmId)) });
    if (!row) throw AppError.notFound('W-9 request');
    if (row.status === 'completed') throw AppError.state('Already completed');
    // reissue token + extend expiry
    const crypto = getCrypto();
    const expiresAt = new Date(Date.now() + W9_EXPIRY_DAYS * 86_400_000);
    const token = crypto.signScopedToken('w9', id, expiresAt);
    await db
      .update(w9Requests)
      .set({ tokenHash: crypto.tokenHash(token), expiresAt, status: 'sent', remindersSent: row.remindersSent + 1, lastReminderAt: new Date() })
      .where(eq(w9Requests.id, id));
    const env = loadEnv();
    const link = `${env.PORTAL_BASE_URL}/w9/${encodeURIComponent(token)}`;
    const firm = await db.query.firms.findFirst({ where: eq(firms.id, req.staff!.firmId) });
    const vars = { firmName: firm?.name ?? '', link, expires: expiresAt.toISOString().slice(0, 10) };
    if (row.email) {
      const job: DeliveryJob = { kind: 'w9_reminder', channel: 'email', firmId: row.firmId, to: row.email, templateKey: 'w9_reminder', vars, w9RequestId: id };
      await getQueue(QUEUE_NAMES.delivery).add('w9_reminder', job);
    }
    if (row.mobile) {
      const job: DeliveryJob = { kind: 'w9_reminder', channel: 'sms', firmId: row.firmId, to: row.mobile, templateKey: 'w9_reminder', vars, w9RequestId: id };
      await getQueue(QUEUE_NAMES.delivery).add('w9_reminder', job);
    }
    res.locals['audit'] = { action: 'w9.resend', entityType: 'w9_request', entityId: id };
    res.json({ ok: true, link });
  }),
);

/**
 * W-9 campaign: request a W-9 from every vault recipient missing/stale on W-9
 * that has an email or mobile — one action instead of dozens of individual asks.
 */
w9StaffRouter.post(
  '/campaign',
  h(async (req, res) => {
    const { limit, payerIds, taxYear } = z
      .object({
        limit: z.number().int().min(1).max(1000).default(500),
        payerIds: z.array(z.string().uuid()).max(2000).optional(), // scope to recipients active under these payers
        taxYear: z.number().int().optional(),
      })
      .parse(req.body ?? {});
    const db = getDb();
    const firmId = req.staff!.firmId;
    const conds = [
      eq(recipients.firmId, firmId),
      isNull(recipients.mergedIntoId),
      inArray(recipients.w9Status, ['none', 'stale']),
      sql`(${recipients.email} IS NOT NULL OR ${recipients.mobile} IS NOT NULL)`,
    ];
    if (payerIds?.length) {
      // only recipients that have a form under the selected payers (+year if given)
      const sub = db
        .selectDistinct({ rid: formRecords.recipientId })
        .from(formRecords)
        .where(and(eq(formRecords.firmId, firmId), inArray(formRecords.payerId, payerIds), ...(taxYear ? [eq(formRecords.taxYear, taxYear)] : [])));
      conds.push(sql`${recipients.id} IN ${sub}`);
    }
    const eligibleWhere = and(...conds);
    const [eligibleRow] = await db.select({ n: sql<number>`count(*)::int` }).from(recipients).where(eligibleWhere);
    const targets = await db.select().from(recipients).where(eligibleWhere).limit(limit);
    let requested = 0;
    const skipped: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];
    for (const r of targets) {
      try {
        // skip if an open request already exists (firm-scoped)
        const open = await db.query.w9Requests.findFirst({
          where: and(eq(w9Requests.firmId, firmId), eq(w9Requests.recipientId, r.id), inArray(w9Requests.status, ['sent', 'opened'])),
        });
        if (open) { skipped.push(r.id); continue; }
        await createW9Request({
          firmId,
          recipientId: r.id,
          requestedName: r.name1,
          email: r.email,
          mobile: r.mobile,
          requestedBy: req.staff!.userId,
          requestedVia: 'staff',
        });
        requested++;
      } catch (err) {
        failed.push({ id: r.id, reason: (err as Error).message });
      }
    }
    await notify(db, {
      firmId,
      kind: 'w9',
      severity: 'success',
      title: 'W-9 campaign sent',
      body: `${requested} W-9 request(s) sent${skipped.length ? `, ${skipped.length} skipped (already open)` : ''}.`,
      link: '/w9',
    });
    res.locals['audit'] = { action: 'w9.campaign', entityType: 'w9_request', detail: { requested, skipped: skipped.length, failed: failed.length } };
    res.json({
      requested,
      skipped: skipped.length,
      failed: failed.length,
      eligible: eligibleRow?.n ?? targets.length,
      processed: targets.length,
      more: (eligibleRow?.n ?? 0) > targets.length,
    });
  }),
);

/** Stale-W-9 detection + bulk re-request. */
w9StaffRouter.post(
  '/stale-sweep',
  h(async (req, res) => {
    const db = getDb();
    const staleYears = (await getSetting<number>('w9_stale_years')) ?? 3;
    const cutoff = new Date(Date.now() - staleYears * 365.25 * 86_400_000);
    const marked = await db
      .update(recipients)
      .set({ w9Status: 'stale', updatedAt: new Date() })
      .where(
        and(
          eq(recipients.firmId, req.staff!.firmId),
          eq(recipients.w9Status, 'on_file'),
          lt(recipients.w9CompletedAt, cutoff),
          isNull(recipients.mergedIntoId),
        ),
      )
      .returning({ id: recipients.id });
    res.locals['audit'] = { action: 'w9.stale-sweep', entityType: 'recipient', detail: { marked: marked.length } };
    res.json({ marked: marked.length });
  }),
);

/** Completed W-9 PDF retrieval — audited. */
w9StaffRouter.get(
  '/requests/:id/pdf',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const db = getDb();
    const row = await db.query.w9Requests.findFirst({ where: and(eq(w9Requests.id, id), eq(w9Requests.firmId, req.staff!.firmId)) });
    if (!row?.pdfBlobId) throw AppError.notFound('Completed W-9');
    const blob = await getBlob(db, row.pdfBlobId, req.staff!.firmId);
    if (!blob) throw AppError.notFound('W-9 PDF');
    await audit(db, {
      firmId: req.staff!.firmId,
      actorType: 'staff',
      actorId: req.staff!.userId,
      action: 'w9.pdf-retrieve',
      entityType: 'w9_request',
      entityId: id,
      ip: req.ip,
    });
    res.setHeader('content-disposition', 'attachment; filename="w9.pdf"');
    res.type('application/pdf').send(blob.bytes);
  }),
);

/** Resolve a TIN-mismatch flag after review (never silent overwrite). */
w9StaffRouter.post(
  '/requests/:id/resolve-mismatch',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const { applyTin } = z.object({ applyTin: z.boolean() }).parse(req.body);
    const db = getDb();
    const row = await db.query.w9Requests.findFirst({ where: and(eq(w9Requests.id, id), eq(w9Requests.firmId, req.staff!.firmId)) });
    if (!row || !row.tinMismatch) throw AppError.notFound('Mismatch');
    const submitted = row.submittedData as { tinEncrypted?: string; tinType?: 'SSN' | 'EIN' } | null;
    if (applyTin && row.recipientId && submitted?.tinEncrypted) {
      const tin = getCrypto().decrypt(submitted.tinEncrypted);
      await updateRecipient(db, req.staff!.firmId, row.recipientId, { tin, tinType: submitted.tinType }, 'w9', req.staff!.userId);
    }
    await db.update(w9Requests).set({ tinMismatch: false }).where(eq(w9Requests.id, id));
    res.locals['audit'] = { action: 'w9.resolve-mismatch', entityType: 'w9_request', entityId: id, detail: { applyTin } };
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// public router (recipient-facing, tunnel-exposed)
// ---------------------------------------------------------------------------

export const w9PublicRouter = Router();
w9PublicRouter.use(rateLimit({ key: 'w9-public', limit: 30, windowSec: 60 }));

async function loadW9ByToken(token: string) {
  const crypto = getCrypto();
  const verified = crypto.verifyScopedToken(token, 'w9');
  if (!verified) throw new AppError(ErrorCodes.E_TOKEN_EXPIRED, 'This W-9 link has expired or is invalid', 401);
  const row = await getDb().query.w9Requests.findFirst({ where: eq(w9Requests.id, verified.id) });
  if (!row) throw AppError.notFound('W-9 request');
  if (!safeHexEqual(crypto.tokenHash(token), row.tokenHash)) throw new AppError(ErrorCodes.E_TOKEN_REVOKED, 'This link has been replaced — use the newest link', 401);
  if (row.status === 'revoked') throw new AppError(ErrorCodes.E_TOKEN_REVOKED, 'This link has been revoked', 401);
  if (row.status === 'completed') throw AppError.state('This W-9 has already been submitted');
  if (row.expiresAt.getTime() < Date.now()) throw new AppError(ErrorCodes.E_TOKEN_EXPIRED, 'This link has expired', 401);
  return row;
}

w9PublicRouter.get(
  '/:token',
  h(async (req, res) => {
    const row = await loadW9ByToken(String(req.params['token']));
    const db = getDb();
    if (row.status === 'sent') {
      await db.update(w9Requests).set({ status: 'opened', openedAt: new Date() }).where(eq(w9Requests.id, row.id));
    }
    const firm = await db.query.firms.findFirst({ where: eq(firms.id, row.firmId) });
    res.json({
      firmName: firm?.name ?? '',
      requestedName: row.requestedName,
      expiresAt: row.expiresAt,
    });
  }),
);

w9PublicRouter.post(
  '/:token/submit',
  h(async (req, res) => {
    const row = await loadW9ByToken(String(req.params['token']));
    const input = zW9SubmitInput.parse(req.body);
    if (normalizeTin(input.tin) !== normalizeTin(input.tinConfirm)) {
      throw AppError.validation('TIN entries do not match — re-enter both fields');
    }
    const { tin } = checkTin(input.tin, input.tinType);
    const db = getDb();
    const crypto = getCrypto();

    const esign = {
      ip: req.ip ?? '',
      timestamp: new Date().toISOString(),
      user_agent: String(req.headers['user-agent'] ?? '').slice(0, 300),
      kind: input.signatureKind,
    };

    // render + store the completed W-9 (encrypted blob)
    const pdf = await getRenderClient().render({
      template: 'w9.html',
      data: {
        w9: {
          name: input.name,
          business_name: input.businessName,
          tax_classification_label:
            input.taxClassification === 'other'
              ? `Other: ${input.otherClassification}`
              : (TAX_CLASS_LABELS[input.taxClassification] ?? input.taxClassification),
          exempt_payee_code: input.exemptPayeeCode,
          fatca_exemption_code: input.fatcaExemptionCode,
          address_line: `${input.address.line1}${input.address.line2 ? ', ' + input.address.line2 : ''}, ${input.address.city}, ${input.address.state} ${input.address.zip}`,
          tin_type: input.tinType,
          tin_display: maskTin(tin, input.tinType), // stored PDF shows truncated TIN; full TIN lives in vault
          signature_name: input.signatureName,
          signature_image: input.signatureImage ?? '',
        },
        esign,
      },
    });
    const pdfBlobId = await putBlob(db, {
      firmId: row.firmId,
      kind: 'w9_pdf',
      contentType: 'application/pdf',
      filename: `w9-${row.id}.pdf`,
      bytes: pdf,
      encrypt: true,
    });

    // vault upsert with mismatch guard
    let recipientId = row.recipientId;
    let tinMismatch = false;
    const existingByTin = await lookupByTin(db, row.firmId, tin, input.tinType);

    if (recipientId) {
      const current = await db.query.recipients.findFirst({ where: eq(recipients.id, recipientId) });
      if (current && crypto.tinHash(tin, row.firmId, input.tinType) !== current.tinHash) {
        // vault already has a DIFFERENT TIN for this recipient — flag for staff review, never silently overwrite
        tinMismatch = true;
        await updateRecipient(
          db,
          row.firmId,
          recipientId,
          { name1: input.name, name2: input.businessName, address: input.address },
          'w9',
          null,
        );
      } else {
        await updateRecipient(
          db,
          row.firmId,
          recipientId,
          { name1: input.name, name2: input.businessName, address: input.address, tin, tinType: input.tinType },
          'w9',
          null,
        );
      }
    } else if (existingByTin) {
      recipientId = existingByTin.recipientId;
      await updateRecipient(
        db,
        row.firmId,
        recipientId,
        { name1: input.name, name2: input.businessName, address: input.address },
        'w9',
        null,
      );
    } else {
      const created = await createRecipient(
        db,
        row.firmId,
        {
          tin,
          tinType: input.tinType,
          name1: input.name,
          name2: input.businessName,
          address: input.address,
          email: row.email,
          mobile: row.mobile,
          backupWithholding: false,
        },
        { source: 'w9', onExisting: 'update' },
      );
      recipientId = created.id;
    }

    if (!tinMismatch && recipientId) {
      await db
        .update(recipients)
        .set({ w9Status: 'on_file', w9CompletedAt: new Date(), updatedAt: new Date() })
        .where(eq(recipients.id, recipientId));
    }

    await db
      .update(w9Requests)
      .set({
        status: 'completed',
        completedAt: new Date(),
        recipientId,
        pdfBlobId,
        esignMeta: esign as unknown as Record<string, unknown>,
        tinMismatch,
        submittedData: {
          name: input.name,
          businessName: input.businessName,
          taxClassification: input.taxClassification,
          tinEncrypted: crypto.encrypt(tin),
          tinType: input.tinType,
        },
      })
      .where(eq(w9Requests.id, row.id));

    await audit(db, {
      firmId: row.firmId,
      actorType: 'recipient',
      actorId: row.id,
      action: 'w9.complete',
      entityType: 'w9_request',
      entityId: row.id,
      detail: { tinMismatch },
      ip: req.ip,
    });

    res.json({ ok: true });
  }),
);
