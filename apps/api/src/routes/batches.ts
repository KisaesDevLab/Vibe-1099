/**
 * Paper batch routes (Phase 6): batch builder (deterministic payer → recipient
 * order), chunked render via BullMQ, lifecycle built → printed → delivered,
 * reprints, test pattern, single-form preview.
 */
import { Router } from 'express';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, zFormType, zTaxYear } from '@vibe1099/shared';
import { deleteBlob, getBlob, getQueue, getRenderClient, QUEUE_NAMES, type RenderBatchJob } from '@vibe1099/core';
import { deliveries, formRecords, getDb, paperBatches, payers, recipients } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { requireStaff } from '../middleware/auth.js';
import { renderClientCopyPdf, renderCopy2Pdf, renderPortalPdf, renderTestPattern, renderZfoldSheet } from '../services/render.js';

const RENDER_CHUNK_SIZE = 50; // 500-form batch => 10 chunked jobs (perf target <60s)

export const batchesRouter = Router();
batchesRouter.use(requireStaff());

batchesRouter.get(
  '/',
  h(async (req, res) => {
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) })
      .parse(req.query);
    const db = getDb();
    const where = eq(paperBatches.firmId, req.staff!.firmId);
    const [rows, [countRow]] = await Promise.all([
      db.select().from(paperBatches).where(where).orderBy(desc(paperBatches.createdAt)).limit(q.limit).offset(q.offset),
      db.select({ n: sql<number>`count(*)::int` }).from(paperBatches).where(where),
    ]);
    res.json({ batches: rows, total: countRow?.n ?? 0, limit: q.limit, offset: q.offset });
  }),
);

/** Pre-build preview: per-payer form counts for a build scope (no side effects). */
batchesRouter.post(
  '/preview',
  h(async (req, res) => {
    const input = z
      .object({
        taxYear: zTaxYear,
        payerIds: z.array(z.string().uuid()).min(1).max(2000),
        formTypes: z.array(zFormType).min(1),
        statuses: z.array(z.string()).default(['accepted', 'accepted_with_errors']),
      })
      .parse(req.body);
    const rows = await getDb()
      .select({ payerId: formRecords.payerId, payerName: payers.legalName, n: sql<number>`count(*)::int` })
      .from(formRecords)
      .innerJoin(payers, eq(payers.id, formRecords.payerId))
      .where(
        and(
          eq(formRecords.firmId, req.staff!.firmId),
          eq(formRecords.taxYear, input.taxYear),
          inArray(formRecords.payerId, input.payerIds),
          inArray(formRecords.formType, input.formTypes),
          inArray(formRecords.status, input.statuses as ['accepted']),
        ),
      )
      .groupBy(formRecords.payerId, payers.legalName)
      .orderBy(payers.legalName);
    res.json({ perPayer: rows, total: rows.reduce((n, r) => n + r.n, 0) });
  }),
);

/** Build: select payers/form type/year → one print-ready PDF, deterministic order. */
batchesRouter.post(
  '/',
  h(async (req, res) => {
    const input = z
      .object({
        taxYear: zTaxYear,
        payerIds: z.array(z.string().uuid()).min(1),
        formTypes: z.array(zFormType).min(1),
        label: z.string().max(120).default(''),
        statuses: z.array(z.enum(['accepted', 'accepted_with_errors', 'transmitted', 'ready', 'queued'])).default(['accepted', 'accepted_with_errors']),
        formRecordIds: z.array(z.string().uuid()).optional(), // subset reprint
      })
      .parse(req.body);
    const db = getDb();
    const firmId = req.staff!.firmId;

    const conds = [
      eq(formRecords.firmId, firmId),
      eq(formRecords.taxYear, input.taxYear),
      inArray(formRecords.payerId, input.payerIds),
      inArray(formRecords.formType, input.formTypes),
      inArray(formRecords.status, input.statuses),
    ];
    if (input.formRecordIds?.length) conds.push(inArray(formRecords.id, input.formRecordIds));

    // deterministic order: payer legal name → recipient name
    const rows = await db
      .select({ form: formRecords, payerName: payers.legalName, recipientName: recipients.name1 })
      .from(formRecords)
      .innerJoin(payers, eq(payers.id, formRecords.payerId))
      .innerJoin(recipients, eq(recipients.id, formRecords.recipientId))
      .where(and(...conds))
      .orderBy(payers.legalName, recipients.name1);

    if (!rows.length) throw AppError.validation('No forms match the batch criteria');

    const orderedIds = rows.map((r) => r.form.id);
    const [batch] = await db
      .insert(paperBatches)
      .values({
        firmId,
        taxYear: input.taxYear,
        label: input.label || `Batch ${new Date().toISOString().slice(0, 10)}`,
        formRecordIds: orderedIds,
        formCount: orderedIds.length,
        status: 'building',
        createdBy: req.staff!.userId,
      })
      .returning({ id: paperBatches.id });
    if (!batch) throw new Error('batch insert failed');

    // chunked render jobs (BullMQ) — worker renders, merges, prepends manifest
    const chunkCount = Math.ceil(orderedIds.length / RENDER_CHUNK_SIZE);
    for (let i = 0; i < chunkCount; i++) {
      const job: RenderBatchJob = {
        kind: 'paper_batch',
        paperBatchId: batch.id,
        firmId,
        chunkIndex: i,
        chunkCount,
        formRecordIds: orderedIds.slice(i * RENDER_CHUNK_SIZE, (i + 1) * RENDER_CHUNK_SIZE),
      };
      await getQueue(QUEUE_NAMES.render).add('paper_batch', job);
    }

    res.locals['audit'] = { action: 'batch.create', entityType: 'paper_batch', entityId: batch.id, detail: { forms: orderedIds.length } };
    res.status(201).json({ id: batch.id, formCount: orderedIds.length, chunkCount });
  }),
);

/** Single-form previews (staff QA + reprint-single). Static routes precede /:id. */
batchesRouter.get(
  '/preview/portal/:formId',
  h(async (req, res) => {
    const formId = z.string().uuid().parse(req.params['formId']);
    const pdf = await renderPortalPdf(getDb(), req.staff!.firmId, formId);
    res.type('application/pdf').send(pdf);
  }),
);

/**
 * Batch print from the entry grid. Layouts:
 *  - copyb  (default): full Copy B + instructions, one form per page pair
 *  - zfold: pressure-seal sheets (same imposition the paper batches use)
 *  - client: compact client copy — several forms per page, for the payer's records
 */
batchesRouter.post(
  '/print',
  h(async (req, res) => {
    const { formRecordIds, layout } = z
      .object({
        formRecordIds: z.array(z.string().uuid()).min(1).max(500),
        layout: z.enum(['copyb', 'zfold', 'client']).default('copyb'),
      })
      .parse(req.body);
    const db = getDb();
    let merged: Buffer;
    if (layout === 'client') {
      merged = await renderClientCopyPdf(db, req.staff!.firmId, formRecordIds);
    } else {
      // scope to the firm + keep a stable order (recipient name)
      const owned = await db
        .select({ id: formRecords.id })
        .from(formRecords)
        .innerJoin(recipients, eq(recipients.id, formRecords.recipientId))
        .where(and(eq(formRecords.firmId, req.staff!.firmId), inArray(formRecords.id, formRecordIds)))
        .orderBy(recipients.name1);
      if (!owned.length) throw AppError.notFound('Forms');
      const pdfs: Buffer[] = [];
      for (const f of owned) {
        pdfs.push(layout === 'zfold' ? await renderZfoldSheet(db, req.staff!.firmId, f.id) : await renderPortalPdf(db, req.staff!.firmId, f.id));
      }
      merged = pdfs.length === 1 ? pdfs[0]! : await getRenderClient().merge(pdfs);
    }
    res.locals['audit'] = { action: 'forms.batch-print', entityType: 'form_record', detail: { count: formRecordIds.length, layout } };
    res.type('application/pdf').send(merged);
  }),
);

batchesRouter.get(
  '/preview/zfold/:formId',
  h(async (req, res) => {
    const formId = z.string().uuid().parse(req.params['formId']);
    const pdf = await renderZfoldSheet(getDb(), req.staff!.firmId, formId);
    res.type('application/pdf').send(pdf);
  }),
);

/** Copy 2 (state filing copy) — available when state withholding is present. */
batchesRouter.get(
  '/preview/copy2/:formId',
  h(async (req, res) => {
    const formId = z.string().uuid().parse(req.params['formId']);
    const pdf = await renderCopy2Pdf(getDb(), req.staff!.firmId, formId);
    res.type('application/pdf').send(pdf);
  }),
);

/** Alignment calibration sheet (Settings → pressure-seal). */
batchesRouter.get(
  '/test-pattern',
  h(async (req, res) => {
    const pdf = await renderTestPattern(getDb(), req.staff!.firmId);
    res.type('application/pdf').send(pdf);
  }),
);

batchesRouter.get(
  '/:id',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const batch = await getDb().query.paperBatches.findFirst({
      where: and(eq(paperBatches.id, id), eq(paperBatches.firmId, req.staff!.firmId)),
    });
    if (!batch) throw AppError.notFound('Batch');
    res.json({ batch });
  }),
);

/** Forms in a batch (drill-in): recipient + form for reprint-single. */
batchesRouter.get(
  '/:id/forms',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const db = getDb();
    const batch = await db.query.paperBatches.findFirst({ where: and(eq(paperBatches.id, id), eq(paperBatches.firmId, req.staff!.firmId)) });
    if (!batch) throw AppError.notFound('Batch');
    const ids = batch.formRecordIds;
    const rows = ids.length
      ? await db
          .select({ id: formRecords.id, formType: formRecords.formType, recipientName: recipients.name1, payerName: payers.legalName })
          .from(formRecords)
          .innerJoin(recipients, eq(recipients.id, formRecords.recipientId))
          .innerJoin(payers, eq(payers.id, formRecords.payerId))
          .where(inArray(formRecords.id, ids))
          .orderBy(payers.legalName, recipients.name1)
      : [];
    res.json({ forms: rows, order: ids });
  }),
);

batchesRouter.get(
  '/:id/pdf',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const batch = await getDb().query.paperBatches.findFirst({
      where: and(eq(paperBatches.id, id), eq(paperBatches.firmId, req.staff!.firmId)),
    });
    if (!batch) throw AppError.notFound('Batch');
    if (!batch.pdfBlobId) throw AppError.state('Batch PDF is still rendering');
    const blob = await getBlob(getDb(), batch.pdfBlobId, req.staff!.firmId);
    if (!blob) throw AppError.notFound('Batch PDF');
    res.setHeader('content-disposition', `attachment; filename="${batch.label.replace(/[^\w.-]+/g, '_')}.pdf"`);
    res.type('application/pdf').send(blob.bytes);
  }),
);

/** Lifecycle: built → printed (staff confirms) → delivered; feeds deliveries channel=paper. */
batchesRouter.post(
  '/:id/mark-printed',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const db = getDb();
    const batch = await db.query.paperBatches.findFirst({
      where: and(eq(paperBatches.id, id), eq(paperBatches.firmId, req.staff!.firmId)),
    });
    if (!batch) throw AppError.notFound('Batch');
    if (batch.status !== 'built') throw AppError.state(`Batch is ${batch.status}, not built`);
    await db.update(paperBatches).set({ status: 'printed', printedAt: new Date() }).where(eq(paperBatches.id, id));

    // create paper delivery rows for every form in the batch
    for (const formRecordId of batch.formRecordIds) {
      await db.insert(deliveries).values({
        firmId: batch.firmId,
        formRecordId,
        channel: 'paper',
        sentAt: new Date(),
        paperBatchId: batch.id,
      });
    }
    res.locals['audit'] = { action: 'batch.printed', entityType: 'paper_batch', entityId: id };
    res.json({ ok: true });
  }),
);

/** Delete an UNPRINTED batch (building / built / failed). Once printed or
 * delivered a batch is part of the mailing record and cannot be deleted. */
batchesRouter.delete(
  '/:id',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const db = getDb();
    const batch = await db.query.paperBatches.findFirst({
      where: and(eq(paperBatches.id, id), eq(paperBatches.firmId, req.staff!.firmId)),
    });
    if (!batch) throw AppError.notFound('Batch');
    if (batch.status === 'printed' || batch.status === 'delivered') {
      throw AppError.state('This batch is already printed — it is part of the mailing record and cannot be deleted');
    }
    if (batch.pdfBlobId) await deleteBlob(db, batch.pdfBlobId);
    await db.delete(paperBatches).where(eq(paperBatches.id, id));
    res.locals['audit'] = { action: 'batch.delete', entityType: 'paper_batch', entityId: id, detail: { status: batch.status } };
    res.json({ ok: true });
  }),
);

batchesRouter.post(
  '/:id/mark-delivered',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const db = getDb();
    const batch = await db.query.paperBatches.findFirst({
      where: and(eq(paperBatches.id, id), eq(paperBatches.firmId, req.staff!.firmId)),
    });
    if (!batch) throw AppError.notFound('Batch');
    // A batch can only be marked delivered once it has actually been printed —
    // guard the transition like mark-printed does (mailing-record integrity).
    if (batch.status !== 'printed') throw AppError.state(`Batch is ${batch.status}, not printed`);
    await db
      .update(paperBatches)
      .set({ status: 'delivered', deliveredAt: new Date() })
      .where(and(eq(paperBatches.id, id), eq(paperBatches.firmId, req.staff!.firmId)));
    res.locals['audit'] = { action: 'batch.delivered', entityType: 'paper_batch', entityId: id };
    res.json({ ok: true });
  }),
);

