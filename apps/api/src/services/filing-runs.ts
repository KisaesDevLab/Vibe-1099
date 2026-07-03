/**
 * Filing Run — the fleet-operations abstraction (Phase B). Wraps the existing
 * per-payer services so a firm closes a 100-entity season in a handful of
 * reviewed bulk actions instead of hundreds of clicks.
 *
 * Every run: dry-run PREVIEW (counts/totals/warnings, no side effects) →
 * EXECUTE (idempotent per-payer fan-out) → per-item result + notification.
 * Compliance invariants (per-payer issuer XML, UTID idempotency, reviewer gate,
 * snapshot-on-transmit, MO scoping) all still hold because we call the same
 * single-payer code paths.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { AppError, formatCents } from '@vibe1099/shared';
import { getQueue, getRenderClient, notify, putBlob, QUEUE_NAMES, type IrisTransmitJob } from '@vibe1099/core';
import { filingRuns, formRecords, getDb, payers, type Db } from '@vibe1099/db';
import { composeTransmission } from './iris.js';
import { renderPayerSummaryIfAny } from './reports.js';
import { getSetting } from './settings.js';

export type RunKind = 'transmit' | 'mo_file' | 'paper_batch' | 'summary_zip' | 'invite' | 'w9';

export interface RunItem {
  payerId?: string;
  label: string;
  ok: boolean;
  message?: string;
  refId?: string;
}

export interface RunScope {
  payerIds: string[];
  taxYear: number;
  formTypes?: string[];
  statuses?: string[];
  isCorrection?: boolean;
}

// --- PREVIEW (dry run) -------------------------------------------------------

/** Transmit preview: which payers have queued records, counts + warnings. */
export async function previewTransmit(db: Db, firmId: string, scope: RunScope): Promise<{ items: RunItem[]; total: number }> {
  const rows = await db
    .select({ payerId: formRecords.payerId, payerName: payers.legalName, n: sql<number>`count(*)::int` })
    .from(formRecords)
    .innerJoin(payers, eq(payers.id, formRecords.payerId))
    .where(
      and(
        eq(formRecords.firmId, firmId),
        eq(formRecords.taxYear, scope.taxYear),
        eq(formRecords.status, 'queued'),
        inArray(formRecords.payerId, scope.payerIds),
      ),
    )
    .groupBy(formRecords.payerId, payers.legalName)
    .orderBy(payers.legalName);
  const items: RunItem[] = rows.map((r) => ({ payerId: r.payerId, label: r.payerName, ok: true, message: `${r.n} queued record(s)` }));
  return { items, total: rows.reduce((n, r) => n + r.n, 0) };
}

/** MO preview: MO-source records per payer (reuses the mo route's threshold logic loosely). */
export async function previewMo(db: Db, firmId: string, scope: RunScope): Promise<{ items: RunItem[]; total: number }> {
  const rows = await db
    .select({ payerId: formRecords.payerId, payerName: payers.legalName, n: sql<number>`count(*)::int` })
    .from(formRecords)
    .innerJoin(payers, eq(payers.id, formRecords.payerId))
    .where(
      and(
        eq(formRecords.firmId, firmId),
        eq(formRecords.taxYear, scope.taxYear),
        eq(formRecords.moSource, true),
        inArray(formRecords.status, ['accepted', 'accepted_with_errors', 'transmitted']),
        inArray(formRecords.payerId, scope.payerIds),
      ),
    )
    .groupBy(formRecords.payerId, payers.legalName)
    .orderBy(payers.legalName);
  const items: RunItem[] = rows.map((r) => ({ payerId: r.payerId, label: r.payerName, ok: true, message: `${r.n} MO-source record(s)` }));
  return { items, total: rows.reduce((n, r) => n + r.n, 0) };
}

// --- EXECUTE -----------------------------------------------------------------

export async function createRun(
  db: Db,
  firmId: string,
  kind: RunKind,
  scope: RunScope,
  createdBy: string,
): Promise<string> {
  const [row] = await db
    .insert(filingRuns)
    .values({ firmId, kind, taxYear: scope.taxYear, status: 'running', scope: scope as unknown as Record<string, unknown> })
    .returning({ id: filingRuns.id });
  if (!row) throw new Error('filing run insert failed');
  await db.update(filingRuns).set({ createdBy }).where(eq(filingRuns.id, row.id));
  return row.id;
}

async function finishRun(db: Db, runId: string, firmId: string, kind: RunKind, items: RunItem[], link: string): Promise<void> {
  const succeeded = items.filter((i) => i.ok).length;
  const failed = items.length - succeeded;
  const status = failed === 0 ? 'completed' : succeeded === 0 ? 'failed' : 'partial';
  await db
    .update(filingRuns)
    .set({ status, total: items.length, succeeded, failed, items, resolvedAt: new Date() })
    .where(eq(filingRuns.id, runId));
  await notify(db, {
    firmId,
    kind: 'filing_run',
    severity: failed === 0 ? 'success' : succeeded === 0 ? 'error' : 'warning',
    title: `${kindLabel(kind)} ${status}`,
    body: `${succeeded} succeeded${failed ? `, ${failed} failed` : ''}.`,
    link,
    entityType: 'filing_run',
    entityId: runId,
  });
}

function kindLabel(kind: RunKind): string {
  return { transmit: 'Bulk IRS transmit', mo_file: 'Bulk MO file', paper_batch: 'Bulk paper batch', summary_zip: 'Bulk summary PDFs', invite: 'Bulk invite', w9: 'Bulk W-9 request' }[kind];
}

/**
 * Execute transmit-all: one IRIS submission per payer (preserving per-payer
 * issuer XML + UTID idempotency). Respects the reviewer gate. Returns the run id.
 */
export async function runTransmitAll(db: Db, firmId: string, scope: RunScope, createdBy: string, actorRole: string): Promise<string> {
  const gate = (await getSetting<boolean>('reviewer_gate_enabled')) ?? false;
  if (gate && actorRole === 'preparer') {
    throw AppError.forbidden('Reviewer approval is required to transmit while the reviewer gate is enabled');
  }
  const runId = await createRun(db, firmId, 'transmit', scope, createdBy);
  const items: RunItem[] = [];
  for (const payerId of scope.payerIds) {
    try {
      const result = await composeTransmission(db, firmId, payerId, scope.taxYear, createdBy, { isCorrection: scope.isCorrection });
      const job: IrisTransmitJob = { kind: 'transmit', transmissionId: result.transmissionId, firmId };
      await getQueue(QUEUE_NAMES.iris).add('transmit', job);
      items.push({ payerId, label: payerId, ok: true, message: `${result.recordCount} record(s) queued for transmit`, refId: result.transmissionId });
    } catch (err) {
      // "No queued records" is expected for payers with nothing to file — skip quietly
      const msg = err instanceof AppError ? err.message : String(err);
      if (/No queued records/i.test(msg)) continue;
      items.push({ payerId, label: payerId, ok: false, message: msg });
    }
  }
  // fill payer names
  await labelPayers(db, items);
  await finishRun(db, runId, firmId, 'transmit', items, '/transmissions');
  return runId;
}

async function labelPayers(db: Db, items: RunItem[]): Promise<void> {
  const ids = items.map((i) => i.payerId).filter((x): x is string => !!x);
  if (!ids.length) return;
  const rows = await db.select({ id: payers.id, name: payers.legalName }).from(payers).where(inArray(payers.id, ids));
  const map = new Map(rows.map((r) => [r.id, r.name]));
  for (const it of items) if (it.payerId) it.label = map.get(it.payerId) ?? it.label;
}

/**
 * Generate every selected payer's filing summary and merge into ONE PDF
 * (workpaper packet) instead of 100 separate downloads. Stored as a run blob.
 */
export async function runSummaryAll(db: Db, firmId: string, scope: RunScope, createdBy: string): Promise<string> {
  const runId = await createRun(db, firmId, 'summary_zip', scope, createdBy);
  const items: RunItem[] = [];
  const pdfs: Buffer[] = [];
  for (const payerId of scope.payerIds) {
    try {
      const { hasForms, pdf } = await renderPayerSummaryIfAny(db, firmId, payerId, scope.taxYear);
      if (!hasForms) { items.push({ payerId, label: payerId, ok: true, message: 'no forms — skipped' }); continue; }
      if (pdf) pdfs.push(pdf);
      items.push({ payerId, label: payerId, ok: true, message: 'summary rendered' });
    } catch (err) {
      items.push({ payerId, label: payerId, ok: false, message: err instanceof AppError ? err.message : String(err) });
    }
  }
  await labelPayers(db, items);
  let resultBlobId: string | null = null;
  if (pdfs.length) {
    const merged = await getRenderClient().merge(pdfs);
    resultBlobId = await putBlob(db, {
      firmId,
      kind: 'report_pdf',
      contentType: 'application/pdf',
      filename: `filing-summaries-${scope.taxYear}.pdf`,
      bytes: merged,
    });
  }
  const succeeded = items.filter((i) => i.ok).length;
  const failed = items.length - succeeded;
  await db
    .update(filingRuns)
    .set({
      status: failed === 0 ? 'completed' : succeeded === 0 ? 'failed' : 'partial',
      total: items.length,
      succeeded,
      failed,
      items,
      resultBlobId,
      resolvedAt: new Date(),
    })
    .where(eq(filingRuns.id, runId));
  await notify(db, {
    firmId,
    kind: 'filing_run',
    severity: failed === 0 ? 'success' : 'warning',
    title: `Bulk summary PDFs ${failed === 0 ? 'ready' : 'partial'}`,
    body: `${succeeded} payer summary/ies merged into one PDF.`,
    link: '/dashboard',
    entityType: 'filing_run',
    entityId: runId,
  });
  return runId;
}

export async function getRun(db: Db, firmId: string, runId: string) {
  const row = await db.query.filingRuns.findFirst({ where: and(eq(filingRuns.id, runId), eq(filingRuns.firmId, firmId)) });
  if (!row) throw AppError.notFound('Filing run');
  return row;
}

export { formatCents };
