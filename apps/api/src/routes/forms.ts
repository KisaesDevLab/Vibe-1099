/**
 * Form records (Phase 4): grid CRUD, validation, status machine, duplicates,
 * bulk CSV import, payer summaries (1096-equivalent view), rollforward,
 * registry metadata for the grid UI.
 */
import { Router } from 'express';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  AppError,
  formatCents,
  getFormDef,
  listFormDefs,
  parseCents,
  sumCents,
  zFormRecordInput,
  zFormType,
  zTaxYear,
  type FormStatus,
  type FormType,
} from '@vibe1099/shared';
import { formRecords, getDb, payers, recipients } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { requireStaff } from '../middleware/auth.js';
import {
  assertDeletableStatus,
  assertEditableStatus,
  assertYearOpen,
  findDuplicates,
  nextAccountNumber,
  transitionStatus,
  validateFormRecord,
} from '../services/forms.js';
import { getSetting, thresholdOverride } from '../services/settings.js';
import { toPublicRecipient } from '../services/vault.js';

export const formsRouter = Router();
formsRouter.use(requireStaff());

// registry metadata for grid construction
formsRouter.get(
  '/registry/:taxYear',
  h(async (req, res) => {
    const taxYear = zTaxYear.parse(Number(req.params['taxYear']));
    const defs = listFormDefs(taxYear);
    if (!defs.length) throw AppError.validation(`No registry definitions for TY${taxYear}`);
    const overrides = await Promise.all(defs.map((d) => thresholdOverride(d.formType, taxYear)));
    res.json({
      forms: defs.map((d, i) => ({
        formType: d.formType,
        taxYear: d.taxYear,
        title: d.title,
        federalThresholdCents: overrides[i] ?? d.federalThresholdCents ?? null,
        thresholdOverridden: overrides[i] != null,
        boxes: d.boxes.map((b) => ({
          id: b.id,
          boxNumber: b.boxNumber,
          label: b.label,
          kind: b.kind,
          stateField: !!b.stateField,
        })),
      })),
    });
  }),
);

function toPublicForm(f: typeof formRecords.$inferSelect) {
  return {
    id: f.id,
    payerId: f.payerId,
    recipientId: f.recipientId,
    taxYear: f.taxYear,
    formType: f.formType,
    boxValues: f.boxValues,
    accountNumber: f.accountNumber,
    secondTinNotice: f.secondTinNotice,
    moSource: f.moSource,
    status: f.status,
    clientSubmitted: f.clientSubmitted,
    correctionSeq: f.correctionSeq,
    correctionType: f.correctionType,
    correctsId: f.correctsId,
    recordErrors: f.recordErrors,
    notes: f.notes,
    transmissionId: f.transmissionId,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

formsRouter.get(
  '/',
  h(async (req, res) => {
    const q = z
      .object({
        payerId: z.string().uuid().optional(),
        recipientId: z.string().uuid().optional(),
        taxYear: z.coerce.number().int().optional(),
        formType: zFormType.optional(),
        status: z.string().optional(),
        clientSubmitted: z.coerce.boolean().optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(500),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const conds = [eq(formRecords.firmId, req.staff!.firmId)];
    if (q.payerId) conds.push(eq(formRecords.payerId, q.payerId));
    if (q.recipientId) conds.push(eq(formRecords.recipientId, q.recipientId));
    if (q.taxYear) conds.push(eq(formRecords.taxYear, q.taxYear));
    if (q.formType) conds.push(eq(formRecords.formType, q.formType));
    if (q.status) conds.push(inArray(formRecords.status, q.status.split(',') as FormStatus[]));
    if (q.clientSubmitted !== undefined) conds.push(eq(formRecords.clientSubmitted, q.clientSubmitted));

    const rows = await getDb()
      .select()
      .from(formRecords)
      .where(and(...conds))
      .orderBy(desc(formRecords.updatedAt))
      .limit(q.limit)
      .offset(q.offset);

    // join recipient display names for the grid
    const recipientIds = [...new Set(rows.map((r) => r.recipientId))];
    const recips = recipientIds.length
      ? await getDb().select().from(recipients).where(inArray(recipients.id, recipientIds))
      : [];
    const rmap = new Map(recips.map((r) => [r.id, toPublicRecipient(r)]));
    res.json({ forms: rows.map((f) => ({ ...toPublicForm(f), recipient: rmap.get(f.recipientId) ?? null })) });
  }),
);

formsRouter.post(
  '/validate',
  h(async (req, res) => {
    const input = zFormRecordInput.parse(req.body);
    const issues = await validateFormRecord(getDb(), req.staff!.firmId, input);
    res.json({ issues });
  }),
);

formsRouter.post(
  '/',
  h(async (req, res) => {
    const input = zFormRecordInput.parse(req.body);
    const db = getDb();
    const firmId = req.staff!.firmId;
    await assertYearOpen(db, firmId, input.taxYear);
    getFormDef(input.formType, input.taxYear); // throws on unsupported

    const payer = await db.query.payers.findFirst({ where: and(eq(payers.id, input.payerId), eq(payers.firmId, firmId)) });
    if (!payer) throw AppError.notFound('Payer');

    const issues = await validateFormRecord(db, firmId, input);
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length) throw AppError.validation('Form has validation errors', errors);

    const dupes = await findDuplicates(db, firmId, input.payerId, input.recipientId, input.formType, input.taxYear);
    let accountNumber = input.accountNumber ?? '';
    if (dupes.length && !accountNumber) {
      accountNumber = await nextAccountNumber(db, firmId, input.payerId, input.recipientId, input.formType, input.taxYear);
    }

    const [created] = await db
      .insert(formRecords)
      .values({
        firmId,
        payerId: input.payerId,
        recipientId: input.recipientId,
        taxYear: input.taxYear,
        formType: input.formType,
        boxValues: input.boxValues as Record<string, number | boolean | string | null>,
        accountNumber,
        secondTinNotice: input.secondTinNotice ?? false,
        moSource: input.moSource ?? payer.moSourceDefault,
        notes: input.notes ?? '',
        createdBy: req.staff!.userId,
      })
      .returning();
    res.locals['audit'] = { action: 'form.create', entityType: 'form_record', entityId: created?.id };
    res.status(201).json({
      form: created ? toPublicForm(created) : null,
      warnings: issues.filter((i) => i.severity === 'warning'),
      duplicateWarning: dupes.length
        ? `Recipient already has ${dupes.length} 1099-${input.formType} for ${input.taxYear} with this payer — account number assigned`
        : null,
    });
  }),
);

formsRouter.patch(
  '/:id',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const patch = zFormRecordInput.partial().parse(req.body);
    const db = getDb();
    const firmId = req.staff!.firmId;
    const record = await db.query.formRecords.findFirst({ where: and(eq(formRecords.id, id), eq(formRecords.firmId, firmId)) });
    if (!record) throw AppError.notFound('Form record');
    assertEditableStatus(record);
    await assertYearOpen(db, firmId, record.taxYear);

    const merged = {
      formType: record.formType,
      taxYear: record.taxYear,
      recipientId: patch.recipientId ?? record.recipientId,
      boxValues: (patch.boxValues ?? record.boxValues) as Record<string, number | boolean | string | null>,
      secondTinNotice: patch.secondTinNotice ?? record.secondTinNotice,
    };
    const issues = await validateFormRecord(db, firmId, merged);
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length) throw AppError.validation('Form has validation errors', errors);

    // edits to a rejected record return it to draft (status machine)
    const nextStatus = record.status === 'rejected' ? 'draft' : record.status;

    const [updated] = await db
      .update(formRecords)
      .set({
        boxValues: merged.boxValues,
        recipientId: merged.recipientId,
        accountNumber: patch.accountNumber ?? record.accountNumber,
        secondTinNotice: merged.secondTinNotice,
        moSource: patch.moSource ?? record.moSource,
        notes: patch.notes ?? record.notes,
        status: nextStatus,
        updatedAt: new Date(),
      })
      .where(eq(formRecords.id, id))
      .returning();
    res.locals['audit'] = { action: 'form.update', entityType: 'form_record', entityId: id, before: record.boxValues, after: merged.boxValues };
    res.json({ form: updated ? toPublicForm(updated) : null, warnings: issues.filter((i) => i.severity === 'warning') });
  }),
);

formsRouter.delete(
  '/:id',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const db = getDb();
    const record = await db.query.formRecords.findFirst({
      where: and(eq(formRecords.id, id), eq(formRecords.firmId, req.staff!.firmId)),
    });
    if (!record) throw AppError.notFound('Form record');
    assertDeletableStatus(record);
    await db.delete(formRecords).where(eq(formRecords.id, id));
    res.locals['audit'] = { action: 'form.delete', entityType: 'form_record', entityId: id, before: record.boxValues };
    res.json({ ok: true });
  }),
);

formsRouter.post(
  '/:id/status',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const { to } = z.object({ to: z.enum(['draft', 'ready', 'queued']) }).parse(req.body);
    const reviewerGate = (await getSetting<boolean>('reviewer_gate_enabled')) ?? false;
    const updated = await transitionStatus(getDb(), req.staff!.firmId, id, to as FormStatus, {
      actorId: req.staff!.userId,
      actorRole: req.staff!.role,
      reviewerGateEnabled: reviewerGate,
    });
    res.locals['audit'] = { action: `form.status.${to}`, entityType: 'form_record', entityId: id };
    res.json({ form: toPublicForm(updated) });
  }),
);

// bulk status (grid multi-select)
formsRouter.post(
  '/bulk-status',
  h(async (req, res) => {
    const { ids, to } = z
      .object({ ids: z.array(z.string().uuid()).min(1).max(2000), to: z.enum(['draft', 'ready', 'queued']) })
      .parse(req.body);
    const reviewerGate = (await getSetting<boolean>('reviewer_gate_enabled')) ?? false;
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of ids) {
      try {
        await transitionStatus(getDb(), req.staff!.firmId, id, to as FormStatus, {
          actorId: req.staff!.userId,
          actorRole: req.staff!.role,
          reviewerGateEnabled: reviewerGate,
        });
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, error: (err as Error).message });
      }
    }
    res.locals['audit'] = { action: `form.bulk-status.${to}`, entityType: 'form_record', detail: { count: ids.length } };
    res.json({ results });
  }),
);

// bulk CSV import of form data with validation report
formsRouter.post(
  '/import',
  h(async (req, res) => {
    const { payerId, taxYear, formType, rows } = z
      .object({
        payerId: z.string().uuid(),
        taxYear: zTaxYear,
        formType: zFormType,
        rows: z.array(z.object({ tinLast4OrTin: z.string(), recipientId: z.string().uuid().optional(), amounts: z.record(z.string()) })).max(5000),
      })
      .parse(req.body);
    const db = getDb();
    const firmId = req.staff!.firmId;
    await assertYearOpen(db, firmId, taxYear);
    // verify the payer belongs to this firm before inserting any records against it
    const importPayer = await db.query.payers.findFirst({ where: and(eq(payers.id, payerId), eq(payers.firmId, firmId)) });
    if (!importPayer) throw AppError.notFound('Payer');
    const def = getFormDef(formType, taxYear);
    const report: Array<{ row: number; status: 'created' | 'error'; message?: string }> = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      try {
        let recipientId = r.recipientId;
        if (!recipientId) throw new Error('recipientId required (map via vault lookup first)');
        const boxValues: Record<string, number | boolean | string | null> = {};
        for (const [boxId, raw] of Object.entries(r.amounts)) {
          const box = def.boxes.find((b) => b.id === boxId);
          if (!box) throw new Error(`Unknown box ${boxId}`);
          if (box.kind === 'cents') boxValues[boxId] = parseCents(raw);
          else if (box.kind === 'checkbox') boxValues[boxId] = raw === 'true' || raw === '1' || raw.toLowerCase() === 'x';
          else boxValues[boxId] = raw;
        }
        const issues = await validateFormRecord(db, firmId, { formType, taxYear, boxValues, recipientId, secondTinNotice: false });
        const errors = issues.filter((x) => x.severity === 'error');
        if (errors.length) throw new Error(errors.map((e) => e.message).join('; '));
        await db.insert(formRecords).values({
          firmId,
          payerId,
          recipientId,
          taxYear,
          formType,
          boxValues,
          moSource: false,
          createdBy: req.staff!.userId,
        });
        report.push({ row: i + 1, status: 'created' });
      } catch (err) {
        report.push({ row: i + 1, status: 'error', message: (err as Error).message });
      }
    }
    res.locals['audit'] = { action: 'form.import', entityType: 'form_record', detail: { payerId, taxYear, formType, count: rows.length } };
    res.json({ report });
  }),
);

// payer-level summary: 1096-equivalent screen view
formsRouter.get(
  '/summary/:payerId/:taxYear',
  h(async (req, res) => {
    const payerId = z.string().uuid().parse(req.params['payerId']);
    const taxYear = zTaxYear.parse(Number(req.params['taxYear']));
    const db = getDb();
    const rows = await db
      .select()
      .from(formRecords)
      .where(
        and(
          eq(formRecords.firmId, req.staff!.firmId),
          eq(formRecords.payerId, payerId),
          eq(formRecords.taxYear, taxYear),
          sql`${formRecords.status} != 'corrected'`,
        ),
      );
    const byType: Record<string, { count: number; totalsByBox: Record<string, number>; statuses: Record<string, number> }> = {};
    for (const r of rows) {
      const bucket = (byType[r.formType] ??= { count: 0, totalsByBox: {}, statuses: {} });
      bucket.count++;
      bucket.statuses[r.status] = (bucket.statuses[r.status] ?? 0) + 1;
      const def = getFormDef(r.formType as FormType, taxYear);
      for (const box of def.boxes) {
        if (box.kind !== 'cents') continue;
        const v = r.boxValues[box.id];
        if (typeof v === 'number' && v > 0) {
          bucket.totalsByBox[box.id] = (bucket.totalsByBox[box.id] ?? 0) + v;
        }
      }
    }
    const summary = Object.entries(byType).map(([formType, b]) => {
      const def = getFormDef(formType as FormType, taxYear);
      return {
        formType,
        count: b.count,
        statuses: b.statuses,
        totals: Object.entries(b.totalsByBox).map(([boxId, cents]) => ({
          boxId,
          label: def.boxes.find((x) => x.id === boxId)?.label ?? boxId,
          cents,
          display: formatCents(cents),
        })),
        grandTotal: formatCents(sumCents(Object.values(b.totalsByBox))),
      };
    });
    res.json({ summary });
  }),
);

// prior-year rollforward: clone recipient set into new-year draft grid (amounts blank)
formsRouter.post(
  '/rollforward',
  h(async (req, res) => {
    const { payerId, fromYear, toYear, formType } = z
      .object({ payerId: z.string().uuid(), fromYear: zTaxYear, toYear: zTaxYear, formType: zFormType.optional() })
      .parse(req.body);
    const db = getDb();
    const firmId = req.staff!.firmId;
    await assertYearOpen(db, firmId, toYear);

    const prior = await db
      .selectDistinct({ recipientId: formRecords.recipientId, formType: formRecords.formType })
      .from(formRecords)
      .where(and(eq(formRecords.firmId, firmId), eq(formRecords.payerId, payerId), eq(formRecords.taxYear, fromYear)));

    const existing = await db
      .select({ recipientId: formRecords.recipientId, formType: formRecords.formType })
      .from(formRecords)
      .where(and(eq(formRecords.firmId, firmId), eq(formRecords.payerId, payerId), eq(formRecords.taxYear, toYear)));
    const existingKeys = new Set(existing.map((e) => `${e.recipientId}:${e.formType}`));

    let created = 0;
    for (const p of prior) {
      if (formType && p.formType !== formType) continue;
      if (existingKeys.has(`${p.recipientId}:${p.formType}`)) continue;
      await db.insert(formRecords).values({
        firmId,
        payerId,
        recipientId: p.recipientId,
        taxYear: toYear,
        formType: p.formType,
        boxValues: {}, // amounts blank per plan
        moSource: false,
        createdBy: req.staff!.userId,
      });
      created++;
    }
    res.locals['audit'] = { action: 'form.rollforward', entityType: 'form_record', detail: { payerId, fromYear, toYear, created } };
    res.json({ created });
  }),
);
