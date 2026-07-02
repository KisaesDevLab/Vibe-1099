/**
 * Filing Run routes (Phase B): dry-run previews + fleet execution for
 * transmit-all and summary-all, plus run history and result download.
 */
import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, zTaxYear } from '@vibe1099/shared';
import { getBlob } from '@vibe1099/core';
import { filingRuns, getDb } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { requireStaff } from '../middleware/auth.js';
import { getRun, previewMo, previewTransmit, runSummaryAll, runTransmitAll, type RunScope } from '../services/filing-runs.js';

export const runsRouter = Router();
runsRouter.use(requireStaff());

const zScope = z.object({
  payerIds: z.array(z.string().uuid()).min(1),
  taxYear: zTaxYear,
  isCorrection: z.boolean().optional(),
});

/** Dry-run preview (no side effects): counts + per-payer warnings. */
runsRouter.post(
  '/transmit/preview',
  h(async (req, res) => {
    const scope = zScope.parse(req.body) as RunScope;
    res.json(await previewTransmit(getDb(), req.staff!.firmId, scope));
  }),
);

runsRouter.post(
  '/mo/preview',
  h(async (req, res) => {
    const scope = zScope.parse(req.body) as RunScope;
    res.json(await previewMo(getDb(), req.staff!.firmId, scope));
  }),
);

/** Execute transmit-all: one IRIS submission per payer. Reviewer-gate enforced. */
runsRouter.post(
  '/transmit',
  requireStaff('admin', 'reviewer'),
  h(async (req, res) => {
    const scope = zScope.parse(req.body) as RunScope;
    const runId = await runTransmitAll(getDb(), req.staff!.firmId, scope, req.staff!.userId, req.staff!.role);
    res.locals['audit'] = { action: 'run.transmit-all', entityType: 'filing_run', entityId: runId, detail: { payers: scope.payerIds.length } };
    res.status(202).json({ runId });
  }),
);

/** Execute summary-all: every payer summary merged into one workpaper PDF. */
runsRouter.post(
  '/summary',
  h(async (req, res) => {
    const scope = zScope.parse(req.body) as RunScope;
    const runId = await runSummaryAll(getDb(), req.staff!.firmId, scope, req.staff!.userId);
    res.locals['audit'] = { action: 'run.summary-all', entityType: 'filing_run', entityId: runId, detail: { payers: scope.payerIds.length } };
    res.status(202).json({ runId });
  }),
);

runsRouter.get(
  '/',
  h(async (req, res) => {
    const rows = await getDb()
      .select()
      .from(filingRuns)
      .where(eq(filingRuns.firmId, req.staff!.firmId))
      .orderBy(desc(filingRuns.createdAt))
      .limit(50);
    res.json({ runs: rows });
  }),
);

runsRouter.get(
  '/:id',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    res.json({ run: await getRun(getDb(), req.staff!.firmId, id) });
  }),
);

runsRouter.get(
  '/:id/download',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const run = await getDb().query.filingRuns.findFirst({ where: and(eq(filingRuns.id, id), eq(filingRuns.firmId, req.staff!.firmId)) });
    if (!run?.resultBlobId) throw AppError.notFound('Run result');
    const blob = await getBlob(getDb(), run.resultBlobId, req.staff!.firmId);
    if (!blob) throw AppError.notFound('Run result blob');
    res.setHeader('content-disposition', `attachment; filename="filing-summaries-${run.taxYear}.pdf"`);
    res.type('application/pdf').send(blob.bytes);
  }),
);
