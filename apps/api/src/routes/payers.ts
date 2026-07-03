/**
 * Payers (the firm's clients issuing 1099s).
 */
import { Router } from 'express';
import { and, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, formatTin, maskTin, normalizeTin, zPayerInput, zTaxYear } from '@vibe1099/shared';
import { audit, getCrypto } from '@vibe1099/core';
import { clientInvites, formRecords, getDb, payers, recipients } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { requireStaff } from '../middleware/auth.js';
import { checkTin } from '../services/vault.js';

export const payersRouter = Router();
payersRouter.use(requireStaff());

function toPublicPayer(p: typeof payers.$inferSelect) {
  return {
    id: p.id,
    legalName: p.legalName,
    dbaName: p.dbaName,
    tinMasked: maskTin(p.tinLast4, p.tinType),
    tinType: p.tinType,
    address: p.address,
    phone: p.phone,
    contactEmail: p.contactEmail,
    contactMobile: p.contactMobile,
    moWithholdingId: p.moWithholdingId,
    moSourceDefault: p.moSourceDefault,
    defaultFormTypes: p.defaultFormTypes,
    active: p.active,
    createdAt: p.createdAt,
  };
}

payersRouter.get(
  '/',
  h(async (req, res) => {
    const q = z
      .object({
        search: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(1000),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const conds = [eq(payers.firmId, req.staff!.firmId)];
    if (q.search) conds.push(or(ilike(payers.legalName, `%${q.search}%`), ilike(payers.dbaName, `%${q.search}%`))!);
    const db = getDb();
    const [rows, [countRow]] = await Promise.all([
      db
        .select()
        .from(payers)
        .where(and(...conds))
        .orderBy(payers.legalName)
        .limit(q.limit)
        .offset(q.offset),
      db.select({ n: sql<number>`count(*)::int` }).from(payers).where(and(...conds)),
    ]);
    res.json({ payers: rows.map(toPublicPayer), total: countRow?.n ?? 0, limit: q.limit, offset: q.offset });
  }),
);

payersRouter.post(
  '/',
  h(async (req, res) => {
    const input = zPayerInput.parse(req.body);
    const { tin } = checkTin(input.tin, input.tinType);
    const crypto = getCrypto();
    const [created] = await getDb()
      .insert(payers)
      .values({
        firmId: req.staff!.firmId,
        legalName: input.legalName,
        dbaName: input.dbaName ?? '',
        tinEncrypted: crypto.encrypt(tin),
        tinType: input.tinType,
        tinLast4: tin.slice(-4),
        address: input.address as unknown as Record<string, string>,
        phone: input.phone ?? '',
        contactEmail: input.contactEmail ?? null,
        contactMobile: input.contactMobile ?? null,
        moWithholdingId: input.moWithholdingId ?? null,
        moSourceDefault: input.moSourceDefault ?? false,
        defaultFormTypes: input.defaultFormTypes?.length ? input.defaultFormTypes : ['NEC'],
      })
      .returning({ id: payers.id });
    res.locals['audit'] = { action: 'payer.create', entityType: 'payer', entityId: created?.id };
    res.status(201).json({ id: created?.id });
  }),
);

/**
 * Pending sets for smart "add all …" selection on the bulk screens — returns the
 * payer IDs that still need each pipeline step for a tax year, so staff can add
 * exactly the un-processed entities (untransmitted, unmailed, undelivered, …)
 * instead of unchecking a wall of 100.
 */
payersRouter.get(
  '/pending/:taxYear',
  h(async (req, res) => {
    const taxYear = zTaxYear.parse(Number(req.params['taxYear']));
    const db = getDb();
    const firmId = req.staff!.firmId;
    const base = [eq(formRecords.firmId, firmId), eq(formRecords.taxYear, taxYear)];
    const distinctPayers = async (extra: ReturnType<typeof and>[]) =>
      (await db.selectDistinct({ id: formRecords.payerId }).from(formRecords).where(and(...base, ...extra))).map((r) => r.id);

    const [readyToTransmit, accepted, moSource, unmailedPaper, undeliveredElectronic, invitedRows, missingW9Rows] = await Promise.all([
      distinctPayers([eq(formRecords.status, 'queued')]),
      distinctPayers([inArray(formRecords.status, ['accepted', 'accepted_with_errors'])]),
      distinctPayers([eq(formRecords.moSource, true), inArray(formRecords.status, ['accepted', 'accepted_with_errors', 'transmitted'])]),
      distinctPayers([
        inArray(formRecords.status, ['accepted', 'accepted_with_errors']),
        sql`NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.form_record_id = ${formRecords.id} AND d.channel = 'paper' AND d.sent_at IS NOT NULL)`,
      ]),
      distinctPayers([
        inArray(formRecords.status, ['accepted', 'accepted_with_errors']),
        sql`NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.form_record_id = ${formRecords.id} AND d.channel IN ('email','sms') AND d.sent_at IS NOT NULL)`,
      ]),
      db.selectDistinct({ id: clientInvites.payerId }).from(clientInvites).where(and(eq(clientInvites.firmId, firmId), eq(clientInvites.taxYear, taxYear))),
      db
        .selectDistinct({ id: formRecords.payerId })
        .from(formRecords)
        .innerJoin(recipients, eq(recipients.id, formRecords.recipientId))
        .where(and(...base, isNull(recipients.mergedIntoId), inArray(recipients.w9Status, ['none', 'stale']))),
    ]);
    const invited = new Set(invitedRows.map((r) => r.id));
    const allPayers = (await db.select({ id: payers.id }).from(payers).where(and(eq(payers.firmId, firmId), eq(payers.active, true)))).map((p) => p.id);
    res.json({
      readyToTransmit,
      accepted,
      moSource,
      unmailedPaper,
      undeliveredElectronic,
      missingW9: missingW9Rows.map((r) => r.id),
      uninvited: allPayers.filter((p) => !invited.has(p)),
    });
  }),
);

// --- CSV bulk import (onboard 100 payers at once) ------------------------------------

const zPayerImportRow = z.object({
  legalName: z.string().min(1),
  dbaName: z.string().optional().default(''),
  tin: z.string(),
  tinType: z.enum(['SSN', 'EIN']).optional().default('EIN'),
  line1: z.string().min(1),
  line2: z.string().optional().default(''),
  city: z.string().min(1),
  state: z.string().length(2),
  zip: z.string(),
  phone: z.string().optional().default(''),
  contactEmail: z.string().optional().default(''),
  contactMobile: z.string().optional().default(''),
  moWithholdingId: z.string().optional().default(''),
  moSource: z.string().optional().default(''), // "1"/"true"/"yes" → MO-source default on
  defaultFormTypes: z.string().optional().default('NEC'), // e.g. "NEC|MISC"
});

const truthy = (s: string) => ['1', 'true', 'yes', 'y'].includes(s.trim().toLowerCase());

payersRouter.post(
  '/import/preview',
  h(async (req, res) => {
    const { rows } = z.object({ rows: z.array(z.record(z.string())).max(2000) }).parse(req.body);
    const db = getDb();
    const firmId = req.staff!.firmId;
    const existing = await db.select({ tinLast4: payers.tinLast4, legalName: payers.legalName }).from(payers).where(eq(payers.firmId, firmId));
    const existingByName = new Set(existing.map((e) => e.legalName.toLowerCase()));
    const preview = rows.map((raw, i) => {
      const parsed = zPayerImportRow.safeParse(raw);
      if (!parsed.success) return { row: i + 1, status: 'invalid' as const, reason: parsed.error.issues[0]?.message };
      const d = parsed.data;
      const digits = normalizeTin(d.tin);
      if (digits.length !== 9) return { row: i + 1, status: 'invalid' as const, name: d.legalName, reason: 'TIN must be 9 digits' };
      const dup = existingByName.has(d.legalName.toLowerCase());
      return { row: i + 1, status: dup ? ('existing' as const) : ('new' as const), name: d.legalName };
    });
    res.json({ preview });
  }),
);

payersRouter.post(
  '/import',
  h(async (req, res) => {
    const { rows } = z.object({ rows: z.array(z.record(z.string())).max(2000) }).parse(req.body);
    const db = getDb();
    const firmId = req.staff!.firmId;
    const crypto = getCrypto();
    // dedupe against existing payers (by legal name) so a re-run doesn't create
    // duplicate payer records with duplicate encrypted TINs
    const existing = await db.select({ legalName: payers.legalName }).from(payers).where(eq(payers.firmId, firmId));
    const seen = new Set(existing.map((e) => e.legalName.toLowerCase()));
    let created = 0;
    let skipped = 0;
    const errors: Array<{ row: number; reason: string }> = [];
    for (let i = 0; i < rows.length; i++) {
      const parsed = zPayerImportRow.safeParse(rows[i]);
      if (!parsed.success) { errors.push({ row: i + 1, reason: parsed.error.issues[0]?.message ?? 'invalid' }); continue; }
      const d = parsed.data;
      const nameKey = d.legalName.toLowerCase();
      if (seen.has(nameKey)) { skipped++; continue; } // already exists or duplicated within the file
      try {
        const { tin } = checkTin(d.tin, d.tinType);
        const formTypes = d.defaultFormTypes.split(/[|,;]/).map((s) => s.trim().toUpperCase()).filter((s) => ['NEC', 'MISC', 'INT', 'DIV'].includes(s));
        await db.insert(payers).values({
          firmId,
          legalName: d.legalName,
          dbaName: d.dbaName,
          tinEncrypted: crypto.encrypt(tin),
          tinType: d.tinType,
          tinLast4: tin.slice(-4),
          address: { line1: d.line1, line2: d.line2, city: d.city, state: d.state.toUpperCase(), zip: d.zip },
          phone: d.phone,
          contactEmail: d.contactEmail || null,
          contactMobile: d.contactMobile || null,
          moWithholdingId: d.moWithholdingId || null,
          moSourceDefault: truthy(d.moSource),
          defaultFormTypes: formTypes.length ? formTypes : ['NEC'],
        });
        seen.add(nameKey);
        created++;
      } catch (err) {
        errors.push({ row: i + 1, reason: (err as Error).message });
      }
    }
    res.locals['audit'] = { action: 'payer.import', entityType: 'payer', detail: { created, skipped, errorCount: errors.length } };
    res.json({ created, skipped, errors });
  }),
);

payersRouter.get(
  '/:id',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const row = await getDb().query.payers.findFirst({
      where: and(eq(payers.id, id), eq(payers.firmId, req.staff!.firmId)),
    });
    if (!row) throw AppError.notFound('Payer');
    res.json({ payer: toPublicPayer(row) });
  }),
);

payersRouter.patch(
  '/:id',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const input = zPayerInput.partial().parse(req.body);
    const db = getDb();
    const row = await db.query.payers.findFirst({ where: and(eq(payers.id, id), eq(payers.firmId, req.staff!.firmId)) });
    if (!row) throw AppError.notFound('Payer');

    const patch: Partial<typeof payers.$inferInsert> = { updatedAt: new Date() };
    if (input.legalName !== undefined) patch.legalName = input.legalName;
    if (input.dbaName !== undefined) patch.dbaName = input.dbaName;
    if (input.address !== undefined) patch.address = input.address as unknown as Record<string, string>;
    if (input.phone !== undefined) patch.phone = input.phone;
    if (input.contactEmail !== undefined) patch.contactEmail = input.contactEmail;
    if (input.contactMobile !== undefined) patch.contactMobile = input.contactMobile;
    if (input.moWithholdingId !== undefined) patch.moWithholdingId = input.moWithholdingId;
    if (input.moSourceDefault !== undefined) patch.moSourceDefault = input.moSourceDefault;
    if (input.defaultFormTypes !== undefined) patch.defaultFormTypes = input.defaultFormTypes.length ? input.defaultFormTypes : ['NEC'];
    if (input.tin !== undefined) {
      const { tin } = checkTin(input.tin, input.tinType ?? row.tinType);
      patch.tinEncrypted = getCrypto().encrypt(tin);
      patch.tinLast4 = tin.slice(-4);
      if (input.tinType) patch.tinType = input.tinType;
    }
    await db.update(payers).set(patch).where(eq(payers.id, id));
    res.locals['audit'] = { action: 'payer.update', entityType: 'payer', entityId: id };
    res.json({ ok: true });
  }),
);

payersRouter.post(
  '/:id/reveal-tin',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const db = getDb();
    const row = await db.query.payers.findFirst({ where: and(eq(payers.id, id), eq(payers.firmId, req.staff!.firmId)) });
    if (!row) throw AppError.notFound('Payer');
    const tin = getCrypto().decrypt(row.tinEncrypted);
    await audit(db, {
      firmId: req.staff!.firmId,
      actorType: 'staff',
      actorId: req.staff!.userId,
      action: 'tin.reveal',
      entityType: 'payer',
      entityId: id,
      ip: req.ip,
    });
    res.json({ tin: formatTin(tin, row.tinType) });
  }),
);
