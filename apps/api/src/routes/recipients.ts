/**
 * Recipient vault routes (Phase 3): CRUD, lookup-as-you-type, reveal (audited),
 * history, merge, CSV import with dedupe preview, filters, encrypted export.
 */
import { Router } from 'express';
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, zRecipientInput, zTinType, normalizeTin } from '@vibe1099/shared';
import { audit, getCrypto, getRenderClient, parse1099Print } from '@vibe1099/core';
import { formRecords, getDb, payers, recipientAddressHistory, recipients, w9Requests } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { requireStaff } from '../middleware/auth.js';
import {
  createRecipient,
  lookupByTin,
  mergeRecipients,
  revealTin,
  toPublicRecipient,
  updateRecipient,
} from '../services/vault.js';

export const recipientsRouter = Router();
recipientsRouter.use(requireStaff());

// list with filters: by payer, by year, missing TIN-adjacent data
recipientsRouter.get(
  '/',
  h(async (req, res) => {
    const q = z
      .object({
        search: z.string().optional(),
        payerId: z.string().uuid().optional(),
        taxYear: z.coerce.number().int().optional(),
        filter: z.enum(['all', 'missing_address', 'missing_contact', 'missing_w9', 'stale_w9', 'backup_wh']).default('all'),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);

    const db = getDb();
    const firmId = req.staff!.firmId;
    const conds = [eq(recipients.firmId, firmId), isNull(recipients.mergedIntoId)];
    if (q.search) {
      conds.push(
        or(ilike(recipients.name1, `%${q.search}%`), ilike(recipients.name2, `%${q.search}%`), eq(recipients.tinLast4, q.search))!,
      );
    }
    if (q.filter === 'missing_address') conds.push(sql`(${recipients.address}->>'line1') IS NULL OR (${recipients.address}->>'line1') = ''`);
    if (q.filter === 'missing_contact') conds.push(sql`${recipients.email} IS NULL AND ${recipients.mobile} IS NULL`);
    if (q.filter === 'missing_w9') conds.push(eq(recipients.w9Status, 'none'));
    if (q.filter === 'stale_w9') conds.push(eq(recipients.w9Status, 'stale'));
    if (q.filter === 'backup_wh') conds.push(eq(recipients.backupWithholding, true));
    if (q.payerId || q.taxYear) {
      const sub = db
        .select({ rid: formRecords.recipientId })
        .from(formRecords)
        .where(
          and(
            eq(formRecords.firmId, firmId),
            ...(q.payerId ? [eq(formRecords.payerId, q.payerId)] : []),
            ...(q.taxYear ? [eq(formRecords.taxYear, q.taxYear)] : []),
          ),
        );
      conds.push(sql`${recipients.id} IN ${sub}`);
    }

    const [rows, [countRow]] = await Promise.all([
      db
        .select()
        .from(recipients)
        .where(and(...conds))
        .orderBy(recipients.name1)
        .limit(q.limit)
        .offset(q.offset),
      db.select({ n: sql<number>`count(*)::int` }).from(recipients).where(and(...conds)),
    ]);
    res.json({ recipients: rows.map(toPublicRecipient), total: countRow?.n ?? 0, limit: q.limit, offset: q.offset });
  }),
);

// vault stats widget
recipientsRouter.get(
  '/stats',
  h(async (req, res) => {
    const db = getDb();
    const firmId = req.staff!.firmId;
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        w9OnFile: sql<number>`count(*) FILTER (WHERE w9_status = 'on_file')::int`,
        w9Missing: sql<number>`count(*) FILTER (WHERE w9_status = 'none')::int`,
        w9Stale: sql<number>`count(*) FILTER (WHERE w9_status = 'stale')::int`,
        backupWh: sql<number>`count(*) FILTER (WHERE backup_withholding)::int`,
        itin: sql<number>`count(*) FILTER (WHERE is_itin)::int`,
      })
      .from(recipients)
      .where(and(eq(recipients.firmId, firmId), isNull(recipients.mergedIntoId)));
    res.json({ stats: row });
  }),
);

// lookup-as-you-type (staff). POST (not GET) so the plaintext TIN travels in the
// request body, never in a URL/query string that would land in proxy + app logs
// (LOCKED rule: plaintext TIN never in URLs).
recipientsRouter.post(
  '/lookup',
  h(async (req, res) => {
    const q = z.object({ tin: z.string().min(9), tinType: zTinType }).parse(req.body);
    const match = await lookupByTin(getDb(), req.staff!.firmId, q.tin, q.tinType);
    res.json({ match });
  }),
);

recipientsRouter.post(
  '/',
  h(async (req, res) => {
    const input = zRecipientInput.parse(req.body);
    const result = await createRecipient(getDb(), req.staff!.firmId, input, {
      source: 'staff',
      changedBy: req.staff!.userId,
      onExisting: 'reject',
    });
    res.locals['audit'] = { action: 'recipient.create', entityType: 'recipient', entityId: result.id };
    res.status(201).json(result);
  }),
);

recipientsRouter.get(
  '/:id',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const row = await getDb().query.recipients.findFirst({
      where: and(eq(recipients.id, id), eq(recipients.firmId, req.staff!.firmId)),
    });
    if (!row) throw AppError.notFound('Recipient');
    res.json({ recipient: toPublicRecipient(row) });
  }),
);

recipientsRouter.patch(
  '/:id',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const input = zRecipientInput.partial().parse(req.body);
    await updateRecipient(getDb(), req.staff!.firmId, id, input, 'staff', req.staff!.userId);
    res.locals['audit'] = { action: 'recipient.update', entityType: 'recipient', entityId: id };
    res.json({ ok: true });
  }),
);

// reveal-on-click with audit entry
recipientsRouter.post(
  '/:id/reveal-tin',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const tin = await revealTin(getDb(), req.staff!.firmId, id);
    await audit(getDb(), {
      firmId: req.staff!.firmId,
      actorType: 'staff',
      actorId: req.staff!.userId,
      action: 'tin.reveal',
      entityType: 'recipient',
      entityId: id,
      ip: req.ip,
    });
    res.json({ tin });
  }),
);

recipientsRouter.get(
  '/:id/history',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const row = await getDb().query.recipients.findFirst({
      where: and(eq(recipients.id, id), eq(recipients.firmId, req.staff!.firmId)),
    });
    if (!row) throw AppError.notFound('Recipient');
    const history = await getDb()
      .select()
      .from(recipientAddressHistory)
      .where(eq(recipientAddressHistory.recipientId, id))
      .orderBy(desc(recipientAddressHistory.createdAt));
    res.json({ history });
  }),
);

recipientsRouter.post(
  '/merge',
  h(async (req, res) => {
    const { survivorId, duplicateId } = z
      .object({ survivorId: z.string().uuid(), duplicateId: z.string().uuid() })
      .parse(req.body);
    const result = await mergeRecipients(getDb(), req.staff!.firmId, survivorId, duplicateId, req.staff!.userId);
    res.locals['audit'] = {
      action: 'recipient.merge',
      entityType: 'recipient',
      entityId: survivorId,
      detail: { duplicateId, movedForms: result.movedForms },
    };
    res.json(result);
  }),
);

// --- CSV import with column mapper + dedupe-by-TIN preview ---------------------

// --- Prior-year print-PDF import: upload -> extract -> parse -> review proposal ---
// Stateless: nothing is written here. The client reviews/edits the proposal, then
// imports through the existing POST /api/payers and POST /api/recipients/import.
recipientsRouter.post(
  '/import/pdf',
  h(async (req, res) => {
    const { pdf } = z.object({ pdf: z.string().min(100).max(15_000_000) }).parse(req.body);
    const buf = Buffer.from(pdf, 'base64');
    if (!buf.subarray(0, 5).toString('latin1').startsWith('%PDF')) {
      throw AppError.validation('Not a PDF file.');
    }
    const pages = await getRenderClient().extractText(buf);
    const parsed = parse1099Print(pages);

    const db = getDb();
    const firmId = req.staff!.firmId;

    // Vault matches per recipient (tin_hash lookup — no decryption).
    const recipientsOut = [];
    for (const r of parsed.recipients) {
      let match = null;
      if (r.tin && r.tinType) {
        const m = await lookupByTin(db, firmId, r.tin, r.tinType);
        if (m) match = { recipientId: m.recipientId, name1: m.name1, tinMasked: m.tinMasked };
      }
      recipientsOut.push({ ...r, match });
    }

    // Payer match: last4+type narrows, decrypt confirms (payers carry no tin_hash).
    let payerMatch: { payerId: string; legalName: string } | null = null;
    if (parsed.payer?.tin && parsed.payer.tinType) {
      const tin = normalizeTin(parsed.payer.tin);
      const candidates = await db
        .select({ id: payers.id, legalName: payers.legalName, tinEncrypted: payers.tinEncrypted })
        .from(payers)
        .where(and(eq(payers.firmId, firmId), eq(payers.tinLast4, tin.slice(-4)), eq(payers.tinType, parsed.payer.tinType)));
      const crypto = getCrypto();
      const hit = candidates.find((c) => normalizeTin(crypto.decrypt(c.tinEncrypted)) === tin);
      if (hit) payerMatch = { payerId: hit.id, legalName: hit.legalName };
    }

    // Parse is read-only, but it handles a TIN-bearing upload — leave a trace (counts only).
    res.locals['audit'] = {
      action: 'recipient.import.pdf.parse',
      entityType: 'recipient',
      detail: {
        pageCount: pages.length,
        formType: parsed.formType,
        taxYear: parsed.taxYear,
        recipients: recipientsOut.length,
        payerMatched: Boolean(payerMatch),
        warnings: parsed.warnings.length,
      },
    };
    res.json({
      taxYear: parsed.taxYear,
      formType: parsed.formType,
      payer: parsed.payer ? { ...parsed.payer, match: payerMatch } : null,
      recipients: recipientsOut,
      warnings: parsed.warnings,
    });
  }),
);

const zImportRow = z.object({
  tin: z.string(),
  tinType: zTinType.default('SSN'),
  name1: z.string().min(1),
  name2: z.string().default(''),
  line1: z.string().min(1),
  line2: z.string().default(''),
  city: z.string().min(1),
  state: z.string().length(2),
  zip: z.string(),
  email: z.string().default(''),
  mobile: z.string().default(''),
});

recipientsRouter.post(
  '/import/preview',
  h(async (req, res) => {
    const { rows } = z.object({ rows: z.array(z.record(z.string())).max(5000) }).parse(req.body);
    const db = getDb();
    const firmId = req.staff!.firmId;
    const preview: Array<{ row: number; status: 'new' | 'existing' | 'invalid'; name?: string; reason?: string; matchName?: string }> = [];
    const seenInFile = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      const parsed = zImportRow.safeParse(rows[i]);
      if (!parsed.success) {
        preview.push({ row: i + 1, status: 'invalid', reason: parsed.error.issues[0]?.message });
        continue;
      }
      const tin = normalizeTin(parsed.data.tin);
      if (tin.length !== 9) {
        preview.push({ row: i + 1, status: 'invalid', name: parsed.data.name1, reason: 'TIN must be 9 digits' });
        continue;
      }
      if (seenInFile.has(tin)) {
        preview.push({ row: i + 1, status: 'invalid', name: parsed.data.name1, reason: 'Duplicate TIN within file' });
        continue;
      }
      seenInFile.add(tin);
      const match = await lookupByTin(db, firmId, tin, parsed.data.tinType);
      preview.push(
        match
          ? { row: i + 1, status: 'existing', name: parsed.data.name1, matchName: match.name1 }
          : { row: i + 1, status: 'new', name: parsed.data.name1 },
      );
    }
    res.json({ preview });
  }),
);

recipientsRouter.post(
  '/import',
  h(async (req, res) => {
    const { rows, updateExisting } = z
      .object({ rows: z.array(z.record(z.string())).max(5000), updateExisting: z.boolean().default(false) })
      .parse(req.body);
    const db = getDb();
    const firmId = req.staff!.firmId;
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors: Array<{ row: number; reason: string }> = [];
    for (let i = 0; i < rows.length; i++) {
      const parsed = zImportRow.safeParse(rows[i]);
      if (!parsed.success) {
        errors.push({ row: i + 1, reason: parsed.error.issues[0]?.message ?? 'invalid' });
        continue;
      }
      const d = parsed.data;
      try {
        const result = await createRecipient(
          db,
          firmId,
          {
            tin: d.tin,
            tinType: d.tinType,
            name1: d.name1,
            name2: d.name2,
            address: { line1: d.line1, line2: d.line2, city: d.city, state: d.state.toUpperCase(), zip: d.zip },
            email: d.email || null,
            mobile: d.mobile || null,
            backupWithholding: false,
          },
          { source: 'import', changedBy: req.staff!.userId, onExisting: updateExisting ? 'update' : 'return' },
        );
        if (result.existed && updateExisting) updated++;
        else if (result.existed) skipped++;
        else created++;
      } catch (err) {
        errors.push({ row: i + 1, reason: (err as Error).message });
      }
    }
    res.locals['audit'] = { action: 'recipient.import', entityType: 'recipient', detail: { created, updated, skipped, errorCount: errors.length } };
    res.json({ created, updated, skipped, errors });
  }),
);

// staff-only export: JSON payload encrypted with install key (encrypted zip equivalent)
recipientsRouter.post(
  '/export',
  requireStaff('admin'),
  h(async (req, res) => {
    const db = getDb();
    const firmId = req.staff!.firmId;
    const rows = await db
      .select()
      .from(recipients)
      .where(and(eq(recipients.firmId, firmId), isNull(recipients.mergedIntoId)));
    const crypto = getCrypto();
    const payload = rows.map((r) => ({
      tin: crypto.decrypt(r.tinEncrypted),
      tinType: r.tinType,
      name1: r.name1,
      name2: r.name2,
      address: r.address,
      email: r.email,
      mobile: r.mobile,
      w9Status: r.w9Status,
      backupWithholding: r.backupWithholding,
    }));
    const encrypted = crypto.encryptBytes(Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));
    await audit(db, {
      firmId,
      actorType: 'staff',
      actorId: req.staff!.userId,
      action: 'vault.export',
      entityType: 'recipient',
      detail: { count: rows.length },
      ip: req.ip,
    });
    res.setHeader('content-disposition', 'attachment; filename="vault-export.v1099enc"');
    res.type('application/octet-stream').send(encrypted);
  }),
);

// W-9 status per recipient (used by list badges)
recipientsRouter.get(
  '/:id/w9-requests',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const rows = await getDb()
      .select()
      .from(w9Requests)
      .where(and(eq(w9Requests.recipientId, id), eq(w9Requests.firmId, req.staff!.firmId)))
      .orderBy(desc(w9Requests.createdAt));
    res.json({
      requests: rows.map((r) => ({
        id: r.id,
        status: r.status,
        email: r.email,
        mobile: r.mobile,
        expiresAt: r.expiresAt,
        completedAt: r.completedAt,
        remindersSent: r.remindersSent,
        tinMismatch: r.tinMismatch,
        createdAt: r.createdAt,
      })),
    });
  }),
);
