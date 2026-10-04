/**
 * Form engine service (Phase 4): registry validation, guarded status machine,
 * duplicate detection, account-number auto-generation, year locks.
 */
import { and, eq, isNull, ne, notInArray, sql } from 'drizzle-orm';
import {
  AppError,
  ErrorCodes,
  assertTransition,
  canTransition,
  getFormDef,
  isDeletable,
  isEditable,
  isSupportedYear,
  type FormRecordInput,
  type FormStatus,
  type FormType,
  type ValidationIssue,
} from '@vibe1099/shared';
import { formRecords, recipients, yearLocks, type Db } from '@vibe1099/db';
import { thresholdOverride } from './settings.js';

export type FormRecordRow = typeof formRecords.$inferSelect;

export async function assertYearOpen(db: Db, firmId: string, taxYear: number): Promise<void> {
  const lock = await db.query.yearLocks.findFirst({
    where: and(eq(yearLocks.firmId, firmId), eq(yearLocks.taxYear, taxYear)),
  });
  if (lock) {
    throw new AppError(ErrorCodes.E_YEAR_CLOSED, `Tax year ${taxYear} is closed — corrections only`, 409);
  }
}

/** Validate box values via registry + recipient context. Returns issues (errors + warnings). */
export type CorrectionKind = 'one_transaction' | 'two_transaction_zero' | 'two_transaction_new' | 'void';

/** Void / Type-2 zeroing records carry all-zero amounts by design. */
export function isZeroCorrection(correctionType: CorrectionKind | string | null | undefined): boolean {
  return correctionType === 'void' || correctionType === 'two_transaction_zero';
}

export async function validateFormRecord(
  db: Db,
  firmId: string,
  input: Pick<FormRecordInput, 'formType' | 'taxYear' | 'boxValues' | 'recipientId' | 'secondTinNotice'> & {
    correctionType?: CorrectionKind | string | null;
    /** bulk callers resolve the (per form type + year) threshold once instead of one settings read per row */
    federalThresholdCents?: number;
  },
): Promise<ValidationIssue[]> {
  if (!isSupportedYear(input.taxYear)) {
    return [{ severity: 'error', code: 'E_YEAR', message: `Tax year ${input.taxYear} is not supported by the registry` }];
  }
  const def = getFormDef(input.formType, input.taxYear);
  const recipient = await db.query.recipients.findFirst({
    where: and(eq(recipients.id, input.recipientId), eq(recipients.firmId, firmId)),
  });
  if (!recipient) return [{ severity: 'error', code: 'E_RECIPIENT', message: 'Recipient not found in vault' }];

  const issues = def.validate(input.boxValues, {
    backupWithholding: recipient.backupWithholding,
    secondTinNotice: input.secondTinNotice ?? false,
    federalThresholdCents: input.federalThresholdCents ?? (await thresholdOverride(input.formType, input.taxYear)),
    zeroCorrection: isZeroCorrection(input.correctionType),
  });

  // unknown box ids are always errors
  const known = new Set(def.boxes.map((b) => b.id));
  for (const key of Object.keys(input.boxValues)) {
    if (!known.has(key)) {
      issues.push({ severity: 'error', boxId: key, code: 'E_UNKNOWN_BOX', message: `Unknown box "${key}" for 1099-${input.formType} TY${input.taxYear}` });
    }
  }
  return issues;
}

/** Same payer/recipient/type/year duplicate check (warning at create, drives account-number gen). */
export async function findDuplicates(
  db: Db,
  firmId: string,
  payerId: string,
  recipientId: string,
  formType: FormType,
  taxYear: number,
  excludeId?: string,
): Promise<FormRecordRow[]> {
  const conds = [
    eq(formRecords.firmId, firmId),
    eq(formRecords.payerId, payerId),
    eq(formRecords.recipientId, recipientId),
    eq(formRecords.formType, formType),
    eq(formRecords.taxYear, taxYear),
    ne(formRecords.status, 'corrected'),
  ];
  if (excludeId) conds.push(ne(formRecords.id, excludeId));
  return db
    .select()
    .from(formRecords)
    .where(and(...conds));
}

/** Account number required when multiple forms share payer/recipient/type/year. */
export async function nextAccountNumber(
  db: Db,
  firmId: string,
  payerId: string,
  recipientId: string,
  formType: FormType,
  taxYear: number,
): Promise<string> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(formRecords)
    .where(
      and(
        eq(formRecords.firmId, firmId),
        eq(formRecords.payerId, payerId),
        eq(formRecords.recipientId, recipientId),
        eq(formRecords.formType, formType),
        eq(formRecords.taxYear, taxYear),
      ),
    );
  const seq = (row?.n ?? 0) + 1;
  return `${formType}${taxYear}-${String(seq).padStart(3, '0')}`;
}

export interface TransitionOptions {
  actorId: string;
  actorRole: 'admin' | 'preparer' | 'reviewer';
  reviewerGateEnabled: boolean;
}

/** Guarded status transition with reviewer-gate config. */
export async function transitionStatus(
  db: Db,
  firmId: string,
  recordId: string,
  to: FormStatus,
  opts: TransitionOptions,
): Promise<FormRecordRow> {
  const record = await db.query.formRecords.findFirst({
    where: and(eq(formRecords.id, recordId), eq(formRecords.firmId, firmId)),
  });
  if (!record) throw AppError.notFound('Form record');

  const from = record.status as FormStatus;
  if (!canTransition(from, to)) {
    throw AppError.state(`Cannot move a ${from} form to ${to}`);
  }
  assertTransition(from, to);

  // A queued record that compose has already claimed (transmissionId set, XML
  // built, worker about to POST) must not be de-queued: it would become editable
  // or deletable while the IRS still receives the built return, leaving a filed
  // return with no record or a record that no longer matches what was filed.
  if (record.transmissionId && from === 'queued' && to !== 'transmitted') {
    throw AppError.state('This record is bound to an in-flight transmission — wait for the acknowledgement (or the failure release) first');
  }

  // reviewer gate: require reviewer/admin approval before queueing (config)
  if (to === 'queued' && opts.reviewerGateEnabled && opts.actorRole === 'preparer') {
    throw AppError.forbidden('Reviewer approval is required before queueing for transmission');
  }

  // moving to ready re-runs validation and blocks on errors
  if (to === 'ready') {
    const issues = await validateFormRecord(db, firmId, {
      formType: record.formType,
      taxYear: record.taxYear,
      boxValues: record.boxValues,
      recipientId: record.recipientId,
      secondTinNotice: record.secondTinNotice,
      correctionType: record.correctionType,
    });
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length) {
      throw AppError.validation('Form has validation errors', errors);
    }
    if (record.correctionType == null) await assertNoFiledDuplicate(db, record);
  }

  const patch: Partial<typeof formRecords.$inferInsert> = { status: to, updatedAt: new Date() };
  if (to === 'queued' && (opts.actorRole === 'reviewer' || opts.actorRole === 'admin')) {
    patch.reviewedBy = opts.actorId;
  }
  const [updated] = await db.update(formRecords).set(patch).where(eq(formRecords.id, recordId)).returning();
  if (!updated) throw new Error('transition update failed');
  return updated;
}

/**
 * Promotion guard for ORIGINALS: an identical (payer, recipient, year, type,
 * account number) return already past draft would be filed twice. Forms that
 * legitimately coexist carry distinct account numbers (IRS multi-account rule),
 * which is why the match includes the account number; corrections are exempt
 * (their original is terminal `corrected`).
 */
export async function assertNoFiledDuplicate(db: Db, record: FormRecordRow): Promise<void> {
  const dup = await db.query.formRecords.findFirst({
    where: and(
      eq(formRecords.firmId, record.firmId),
      eq(formRecords.payerId, record.payerId),
      eq(formRecords.recipientId, record.recipientId),
      eq(formRecords.taxYear, record.taxYear),
      eq(formRecords.formType, record.formType),
      eq(formRecords.accountNumber, record.accountNumber),
      isNull(formRecords.correctionType),
      ne(formRecords.id, record.id),
      notInArray(formRecords.status, ['draft', 'corrected']),
    ),
  });
  if (dup) {
    throw AppError.state(
      `This recipient already has a ${dup.status} 1099-${record.formType} for ${record.taxYear} with this payer — delete this draft, edit the existing form, or give this one a distinct account number.`,
    );
  }
}

/** A draft/ready record still linked to a transmission is a claimed record the worker may be sending. */
function assertNotInFlight(record: FormRecordRow, verb: string): void {
  if (record.transmissionId && record.status !== 'rejected') {
    throw new AppError(
      ErrorCodes.E_IMMUTABLE,
      `This form is bound to transmission ${record.transmissionId} and cannot be ${verb} — wait for the acknowledgement or release the records from the failed transmission first`,
      409,
    );
  }
}

export function assertEditableStatus(record: FormRecordRow): void {
  if (!isEditable(record.status as FormStatus)) {
    throw new AppError(
      ErrorCodes.E_IMMUTABLE,
      `A ${record.status} form cannot be edited — use the corrections workflow`,
      409,
    );
  }
  assertNotInFlight(record, 'edited');
}

export function assertDeletableStatus(record: FormRecordRow): void {
  if (!isDeletable(record.status as FormStatus)) {
    throw new AppError(
      ErrorCodes.E_IMMUTABLE,
      `A ${record.status} form cannot be deleted — transmitted records require the correction path`,
      409,
    );
  }
  assertNotInFlight(record, 'deleted');
}
