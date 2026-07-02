/**
 * Corrections lifecycle (Phase 11).
 *
 * Classifier:
 *  - Type 1 (one-transaction): wrong amount/code/checkbox, or filed-in-error →
 *    single CORRECTED record from the as-filed snapshot + edits.
 *  - Type 2 (two-transaction): wrong/missing TIN, wrong name, wrong form type →
 *    (1) zeroing record against ORIGINAL TIN/name + (2) new original, linked.
 *
 * Guardrails: corrections only from accepted records; only the latest record in
 * a chain is correctable; diff-from-snapshot shown before queueing.
 */
import { and, eq } from 'drizzle-orm';
import { AppError, isCorrectable, type FormStatus, type FormType } from '@vibe1099/shared';
import { formRecords, getDb, type Db } from '@vibe1099/db';

export type CorrectionClass = 'type1' | 'type2';

export interface CorrectionRequest {
  originalId: string;
  reason: string;
  /** type1: edited box values / account number */
  boxValues?: Record<string, number | boolean | string | null>;
  /** filed-in-error void (type1 zero-out) */
  voidRecord?: boolean;
  /** type2: identity changes */
  newRecipientId?: string;
  newFormType?: FormType;
}

/** Classify from the requested changes. */
export function classifyCorrection(req: CorrectionRequest): CorrectionClass {
  if (req.newRecipientId || req.newFormType) return 'type2';
  return 'type1';
}

export interface CorrectionDiffEntry {
  field: string;
  before: unknown;
  after: unknown;
}

async function loadCorrectable(db: Db, firmId: string, originalId: string) {
  const original = await db.query.formRecords.findFirst({
    where: and(eq(formRecords.id, originalId), eq(formRecords.firmId, firmId)),
  });
  if (!original) throw AppError.notFound('Form record');
  if (!isCorrectable(original.status as FormStatus)) {
    throw AppError.state(`Only accepted records can be corrected (record is ${original.status})`);
  }
  // only the latest in a chain is correctable
  const newer = await db.query.formRecords.findFirst({ where: eq(formRecords.correctsId, originalId) });
  if (newer) throw AppError.state('This record was already corrected — correct the latest version instead');
  if (!original.filedSnapshot) throw AppError.state('Record is missing its as-filed snapshot');
  return original;
}

/** Diff-from-snapshot display before queue. */
export async function correctionDiff(
  db: Db,
  firmId: string,
  req: CorrectionRequest,
): Promise<{ classification: CorrectionClass; diff: CorrectionDiffEntry[] }> {
  const original = await loadCorrectable(db, firmId, req.originalId);
  const snapshot = original.filedSnapshot as { boxValues: Record<string, unknown> };
  const diff: CorrectionDiffEntry[] = [];
  const classification = classifyCorrection(req);

  if (req.voidRecord) {
    diff.push({ field: 'record', before: 'as filed', after: 'VOID (filed in error — all amounts zeroed)' });
  } else if (classification === 'type1' && req.boxValues) {
    const keys = new Set([...Object.keys(snapshot.boxValues ?? {}), ...Object.keys(req.boxValues)]);
    for (const key of keys) {
      const before = (snapshot.boxValues ?? {})[key] ?? null;
      const after = req.boxValues[key] ?? null;
      if (JSON.stringify(before) !== JSON.stringify(after)) diff.push({ field: key, before, after });
    }
  } else {
    if (req.newRecipientId && req.newRecipientId !== original.recipientId) {
      diff.push({ field: 'recipient', before: original.recipientId, after: req.newRecipientId });
    }
    if (req.newFormType && req.newFormType !== original.formType) {
      diff.push({ field: 'formType', before: original.formType, after: req.newFormType });
    }
    if (req.boxValues) diff.push({ field: 'boxValues', before: snapshot.boxValues, after: req.boxValues });
  }
  return { classification, diff };
}

/** Zero out every cents box; keep checkboxes/codes cleared. */
function zeroedBoxValues(boxValues: Record<string, unknown>): Record<string, number | boolean | string | null> {
  const out: Record<string, number | boolean | string | null> = {};
  for (const [k, v] of Object.entries(boxValues)) {
    if (typeof v === 'number') out[k] = 0;
    else if (typeof v === 'boolean') out[k] = false;
    else out[k] = null;
  }
  return out;
}

export interface CorrectionResult {
  classification: CorrectionClass | 'void';
  createdIds: string[];
}

/**
 * Create correction record(s) in `draft` for review → queue → transmit as a
 * correction submission. Marks the original `corrected`.
 */
export async function createCorrection(
  db: Db,
  firmId: string,
  req: CorrectionRequest,
  createdBy: string,
): Promise<CorrectionResult> {
  const original = await loadCorrectable(db, firmId, req.originalId);
  const classification = classifyCorrection(req);
  const nextSeq = original.correctionSeq + 1;
  const createdIds: string[] = [];

  if (req.voidRecord) {
    // filed-in-error: one-transaction zero-out with void semantics
    const [zero] = await db
      .insert(formRecords)
      .values({
        firmId,
        payerId: original.payerId,
        recipientId: original.recipientId,
        taxYear: original.taxYear,
        formType: original.formType,
        boxValues: zeroedBoxValues(original.boxValues),
        accountNumber: original.accountNumber,
        moSource: original.moSource,
        status: 'draft',
        correctsId: original.id,
        correctionSeq: nextSeq,
        correctionType: 'void',
        correctionReason: req.reason,
        createdBy,
      })
      .returning({ id: formRecords.id });
    if (zero) createdIds.push(zero.id);
  } else if (classification === 'type1') {
    if (!req.boxValues) throw AppError.validation('Type 1 correction requires corrected box values');
    const [corrected] = await db
      .insert(formRecords)
      .values({
        firmId,
        payerId: original.payerId,
        recipientId: original.recipientId,
        taxYear: original.taxYear,
        formType: original.formType,
        boxValues: req.boxValues,
        accountNumber: original.accountNumber,
        secondTinNotice: original.secondTinNotice,
        moSource: original.moSource,
        status: 'draft',
        correctsId: original.id,
        correctionSeq: nextSeq,
        correctionType: 'one_transaction',
        correctionReason: req.reason,
        createdBy,
      })
      .returning({ id: formRecords.id });
    if (corrected) createdIds.push(corrected.id);
  } else {
    // Type 2: (1) zeroing record against ORIGINAL TIN/name/form type
    const [zero] = await db
      .insert(formRecords)
      .values({
        firmId,
        payerId: original.payerId,
        recipientId: original.recipientId, // original identity
        taxYear: original.taxYear,
        formType: original.formType,
        boxValues: zeroedBoxValues(original.boxValues),
        accountNumber: original.accountNumber,
        moSource: original.moSource,
        status: 'draft',
        correctsId: original.id,
        correctionSeq: nextSeq,
        correctionType: 'two_transaction_zero',
        correctionReason: req.reason,
        createdBy,
      })
      .returning({ id: formRecords.id });
    if (zero) createdIds.push(zero.id);

    // (2) new original with correct data — linked to the zeroing record
    const [fresh] = await db
      .insert(formRecords)
      .values({
        firmId,
        payerId: original.payerId,
        recipientId: req.newRecipientId ?? original.recipientId,
        taxYear: original.taxYear,
        formType: req.newFormType ?? original.formType,
        boxValues: req.boxValues ?? original.boxValues,
        accountNumber: original.accountNumber,
        secondTinNotice: original.secondTinNotice,
        moSource: original.moSource,
        status: 'draft',
        correctsId: zero?.id ?? original.id, // pair linkage in DB
        correctionSeq: nextSeq,
        correctionType: 'two_transaction_new',
        correctionReason: req.reason,
        createdBy,
      })
      .returning({ id: formRecords.id });
    if (fresh) createdIds.push(fresh.id);
  }

  // original locks into its chain
  await db.update(formRecords).set({ status: 'corrected', updatedAt: new Date() }).where(eq(formRecords.id, original.id));

  return { classification: req.voidRecord ? 'void' : classification, createdIds };
}

/** Full chain visible in record history. */
export async function correctionChain(db: Db, firmId: string, recordId: string) {
  const chain: Array<typeof formRecords.$inferSelect> = [];
  // walk backwards
  let current = await db.query.formRecords.findFirst({ where: and(eq(formRecords.id, recordId), eq(formRecords.firmId, firmId)) });
  if (!current) throw AppError.notFound('Form record');
  const back: Array<typeof formRecords.$inferSelect> = [];
  let cursor = current;
  while (cursor.correctsId) {
    const prev = await db.query.formRecords.findFirst({ where: eq(formRecords.id, cursor.correctsId) });
    if (!prev) break;
    back.push(prev);
    cursor = prev;
  }
  chain.push(...back.reverse(), current);
  // walk forwards
  cursor = current;
  for (;;) {
    const next = await db.query.formRecords.findFirst({ where: eq(formRecords.correctsId, cursor.id) });
    if (!next) break;
    chain.push(next);
    cursor = next;
  }
  return chain;
}
