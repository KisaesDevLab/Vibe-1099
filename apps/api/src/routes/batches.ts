/**
 * Paper batch routes (Phase 6): batch builder (deterministic payer → recipient
 * order), chunked render via BullMQ, lifecycle built → printed → delivered,
 * reprints, test pattern, single-form preview.
 */
import { Router } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, zFormType, zTaxYear } from '@vibe1099/shared';
import { getBlob, getQueue, QUEUE_NAMES, type RenderBatchJob } from '@vibe1099/core';
import { deliveries, formRecords, getDb, paperBatches, payers, recipients } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { requireStaff } from '../middleware/auth.js';
import { renderCopy2Pdf, renderPortalPdf, renderTestPattern, renderZfoldSheet } from '../services/render.js';

const RENDER_CHUNK_SIZE = 50; // 500-form batch => 10 chunked jobs (perf target <60s)

export const batchesRouter = Router();
batchesRouter.use(requireStaff());

batchesRouter.get(
  '/',
  h(async (req, res) => {
    const rows = await getDb().query.paperBatches.findMany({
      where: eq(paperBatches.firmId, req.staff!.firmId),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
    res.json({ batches: rows });
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

batchesRouter.post(
  '/:id/mark-delivered',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const db = getDb();
    await db
      .update(paperBatches)
      .set({ status: 'delivered', deliveredAt: new Date() })
      .where(and(eq(paperBatches.id, id), eq(paperBatches.firmId, req.staff!.firmId)));
    res.locals['audit'] = { action: 'batch.delivered', entityType: 'paper_batch', entityId: id };
    res.json({ ok: true });
  }),
);

