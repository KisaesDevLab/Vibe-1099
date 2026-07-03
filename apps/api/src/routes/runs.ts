/**
 * Filing Run routes (Phase B): dry-run previews + fleet execution for
 * transmit-all and summary-all, plus run history and result download.
 */
import { Router } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, zTaxYear } from '@vibe1099/shared';
import { getBlob } from '@vibe1099/core';
import { filingRuns, getDb } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { requireStaff } from '../middleware/auth.js';
import { fleetEligibility, getRun, previewMo, previewTransmit, retryRun, runSummaryAll, runTransmitAll, type RunScope } from '../services/filing-runs.js';

export const runsRouter = Router();
runsRouter.use(requireStaff());

const zScope = z.object({
  payerIds: z.array(z.string().uuid()).min(1).max(2000).transform((a) => [...new Set(a)]),
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

/** Per-action eligibility counts for the current scope. */
runsRouter.post(
  '/eligibility',
  h(async (req, res) => {
    const { payerIds, taxYear } = z.object({ payerIds: z.array(z.string().uuid()).default([]), taxYear: zTaxYear }).parse(req.body);
    res.json(await fleetEligibility(getDb(), req.staff!.firmId, taxYear, payerIds));
  }),
);

runsRouter.get(
  '/',
  h(async (req, res) => {
    const q = z
      .object({
        kind: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(25),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const db = getDb();
    const conds = [eq(filingRuns.firmId, req.staff!.firmId)];
    if (q.kind) conds.push(eq(filingRuns.kind, q.kind as 'transmit'));
    const [rows, [countRow]] = await Promise.all([
      db.select().from(filingRuns).where(and(...conds)).orderBy(desc(filingRuns.createdAt)).limit(q.limit).offset(q.offset),
      db.select({ n: sql<number>`count(*)::int` }).from(filingRuns).where(and(...conds)),
    ]);
    res.json({ runs: rows, total: countRow?.n ?? 0, limit: q.limit, offset: q.offset });
  }),
);

/** Re-run only the failed payers of a run. */
runsRouter.post(
  '/:id/retry',
  requireStaff('admin', 'reviewer'),
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const runId = await retryRun(getDb(), req.staff!.firmId, id, req.staff!.userId, req.staff!.role);
    res.locals['audit'] = { action: 'run.retry', entityType: 'filing_run', entityId: runId, detail: { from: id } };
    res.status(202).json({ runId });
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
