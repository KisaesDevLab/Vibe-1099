/**
 * Recipient vault & TIN intelligence (Phase 3).
 * AES-256-GCM envelope encryption; tin_hash HMAC lookup without decryption;
 * address/name history versioning; merge; rollforward.
 */
import { and, desc, eq, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import {
  AppError,
  ErrorCodes,
  maskTin,
  normalizeTin,
  tinLast4,
  validateTin,
  type RecipientInput,
  type TinType,
} from '@vibe1099/shared';
import { getCrypto } from '@vibe1099/core';
import { formRecords, getDb, recipientAddressHistory, recipients, type Db } from '@vibe1099/db';

export type RecipientRow = typeof recipients.$inferSelect;

export interface VaultMatch {
  recipientId: string;
  name1: string;
  name2: string;
  address: Record<string, string>;
  tinMasked: string;
  tinType: TinType;
  w9Status: string;
  backupWithholding: boolean;
  lastUsed: { payerName: string; taxYear: number; formType: string } | null;
}

export function toPublicRecipient(r: RecipientRow) {
  return {
    id: r.id,
    tinMasked: maskTin(r.tinLast4, r.tinType),
    tinType: r.tinType,
    isItin: r.isItin,
    name1: r.name1,
    name2: r.name2,
    address: r.address,
    email: r.email,
    mobile: r.mobile,
    smsOptOut: r.smsOptOut,
    w9Status: r.w9Status,
    w9CompletedAt: r.w9CompletedAt,
    backupWithholding: r.backupWithholding,
    createdFrom: r.createdFrom,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Validate + normalize a TIN or throw E_VALIDATION. */
export function checkTin(raw: string, tinType: TinType): { tin: string; isItin: boolean } {
  const result = validateTin(raw, tinType);
  if (!result.valid) throw AppError.validation(result.reason ?? 'Invalid TIN');
  return { tin: normalizeTin(raw), isItin: result.isItin ?? false };
}

/**
 * Lookup-as-you-type: TIN → hash → vault match with most-current name/address + last use.
 *
 * `opts.payerId` scopes the match to recipients that already have a form under that
 * payer. The staff zone omits it (firm-wide vault). The client zone MUST pass its
 * scoped `payerId` so a magic-link client cannot confirm the existence of a TIN that
 * belongs only to another payer in the firm's book (trust-zone isolation; IRC §7216).
 */
export async function lookupByTin(
  db: Db,
  firmId: string,
  rawTin: string,
  tinType: TinType,
  opts?: { payerId?: string },
): Promise<VaultMatch | null> {
  const tin = normalizeTin(rawTin);
  if (tin.length !== 9) return null;
  const hash = getCrypto().tinHash(tin, firmId, tinType);
  const row = await db.query.recipients.findFirst({
    where: and(eq(recipients.firmId, firmId), eq(recipients.tinHash, hash), isNull(recipients.mergedIntoId)),
  });
  if (!row) return null;

  // Client zone: only reveal recipients this payer already files for.
  if (opts?.payerId && !(await payerOwnsRecipient(db, opts.payerId, row.id))) return null;

  const lastForm = await db
    .select({
      taxYear: formRecords.taxYear,
      formType: formRecords.formType,
      payerName: sql<string>`(SELECT legal_name FROM payers WHERE payers.id = ${formRecords.payerId})`,
    })
    .from(formRecords)
    .where(eq(formRecords.recipientId, row.id))
    .orderBy(desc(formRecords.taxYear), desc(formRecords.createdAt))
    .limit(1);

  return {
    recipientId: row.id,
    name1: row.name1,
    name2: row.name2,
    address: row.address,
    tinMasked: maskTin(row.tinLast4, row.tinType),
    tinType: row.tinType,
    w9Status: row.w9Status,
    backupWithholding: row.backupWithholding,
    lastUsed: lastForm[0]
      ? { payerName: lastForm[0].payerName, taxYear: lastForm[0].taxYear, formType: lastForm[0].formType }
      : null,
  };
}

/** Whether a payer already files for this recipient (any year, any status). */
export async function payerOwnsRecipient(db: Db, payerId: string, recipientId: string): Promise<boolean> {
  const owned = await db
    .select({ id: formRecords.id })
    .from(formRecords)
    .where(and(eq(formRecords.recipientId, recipientId), eq(formRecords.payerId, payerId)))
    .limit(1);
  return owned.length > 0;
}

/**
 * Client-zone attachment rule: a payer may use a recipient it already files
 * for, or one the client zone itself created that no payer has a form for yet.
 * Anything else is another payer's vault row — it must stay invisible to this
 * client (trust-zone isolation; IRC §7216).
 */
export async function payerMayUseRecipient(db: Db, payerId: string, recipientId: string): Promise<boolean> {
  if (await payerOwnsRecipient(db, payerId, recipientId)) return true;
  const row = await db.query.recipients.findFirst({ where: eq(recipients.id, recipientId) });
  if (!row || row.createdFrom !== 'client') return false;
  const used = await db.select({ id: formRecords.id }).from(formRecords).where(eq(formRecords.recipientId, recipientId)).limit(1);
  return used.length === 0;
}

export interface UpsertOptions {
  source: 'staff' | 'client' | 'w9' | 'import';
  changedBy?: string | null;
  /** when the TIN already exists: 'update' applies name/address changes; 'reject' throws E_DUPLICATE_TIN */
  onExisting: 'update' | 'reject' | 'return';
}

export async function createRecipient(
  db: Db,
  firmId: string,
  input: RecipientInput,
  opts: UpsertOptions,
): Promise<{ id: string; existed: boolean; nameChanged: boolean }> {
  const { tin, isItin } = checkTin(input.tin, input.tinType);
  const crypto = getCrypto();
  const hash = crypto.tinHash(tin, firmId, input.tinType);

  const existing = await db.query.recipients.findFirst({
    where: and(eq(recipients.firmId, firmId), eq(recipients.tinHash, hash), isNull(recipients.mergedIntoId)),
  });

  if (existing) {
    if (opts.onExisting === 'reject') {
      throw new AppError(ErrorCodes.E_DUPLICATE_TIN, 'A recipient with this TIN already exists in the vault', 409, {
        recipientId: existing.id,
      });
    }
    if (opts.onExisting === 'return') {
      return { id: existing.id, existed: true, nameChanged: existing.name1 !== input.name1 };
    }
    const nameChanged = existing.name1 !== input.name1 || existing.name2 !== (input.name2 ?? '');
    await updateRecipient(db, firmId, existing.id, input, opts.source, opts.changedBy);
    return { id: existing.id, existed: true, nameChanged };
  }

  const [created] = await db
    .insert(recipients)
    .values({
      firmId,
      tinEncrypted: crypto.encrypt(tin),
      tinHash: hash,
      tinType: input.tinType,
      tinLast4: tinLast4(tin),
      isItin,
      name1: input.name1,
      name2: input.name2 ?? '',
      address: input.address as unknown as Record<string, string>,
      email: input.email ?? null,
      mobile: input.mobile ?? null,
      backupWithholding: input.backupWithholding ?? false,
      smsOptOut: input.smsOptOut ?? false,
      createdFrom: opts.source,
    })
    .returning({ id: recipients.id });
  if (!created) throw new Error('recipient insert failed');

  await db.insert(recipientAddressHistory).values({
    recipientId: created.id,
    name1: input.name1,
    name2: input.name2 ?? '',
    address: input.address as unknown as Record<string, string>,
    source: opts.source,
    changedBy: opts.changedBy ?? null,
  });

  return { id: created.id, existed: false, nameChanged: false };
}

export async function updateRecipient(
  db: Db,
  firmId: string,
  id: string,
  input: Partial<RecipientInput>,
  source: 'staff' | 'client' | 'w9' | 'import',
  changedBy?: string | null,
): Promise<void> {
  const row = await db.query.recipients.findFirst({ where: and(eq(recipients.id, id), eq(recipients.firmId, firmId)) });
  if (!row) throw AppError.notFound('Recipient');

  const patch: Partial<typeof recipients.$inferInsert> = { updatedAt: new Date() };
  let identityChanged = false;

  if (input.name1 !== undefined && input.name1 !== row.name1) {
    patch.name1 = input.name1;
    identityChanged = true;
  }
  if (input.name2 !== undefined && input.name2 !== row.name2) {
    patch.name2 = input.name2;
    identityChanged = true;
  }
  if (input.address !== undefined && JSON.stringify(input.address) !== JSON.stringify(row.address)) {
    patch.address = input.address as unknown as Record<string, string>;
    identityChanged = true;
  }
  if (input.email !== undefined) patch.email = input.email;
  if (input.mobile !== undefined) patch.mobile = input.mobile;
  if (input.backupWithholding !== undefined) patch.backupWithholding = input.backupWithholding;
  if (input.smsOptOut !== undefined) patch.smsOptOut = input.smsOptOut;

  if (input.tin !== undefined) {
    const newTinType = input.tinType ?? row.tinType;
    const { tin, isItin } = checkTin(input.tin, newTinType);
    const crypto = getCrypto();
    const newHash = crypto.tinHash(tin, firmId, newTinType);
    if (newHash !== row.tinHash) {
      const clash = await db.query.recipients.findFirst({
        where: and(eq(recipients.firmId, firmId), eq(recipients.tinHash, newHash), isNull(recipients.mergedIntoId)),
      });
      if (clash && clash.id !== id) {
        throw new AppError(ErrorCodes.E_DUPLICATE_TIN, 'Another recipient already has this TIN — use the merge tool', 409, {
          recipientId: clash.id,
        });
      }
      patch.tinEncrypted = crypto.encrypt(tin);
      patch.tinHash = newHash;
      patch.tinLast4 = tinLast4(tin);
      patch.isItin = isItin;
      if (input.tinType) patch.tinType = input.tinType;
    }
  }

  await db.update(recipients).set(patch).where(eq(recipients.id, id));

  if (identityChanged) {
    await db.insert(recipientAddressHistory).values({
      recipientId: id,
      name1: (patch.name1 as string) ?? row.name1,
      name2: (patch.name2 as string) ?? row.name2,
      address: (patch.address as Record<string, string>) ?? row.address,
      source,
      changedBy: changedBy ?? null,
    });
  }
}

/** Merge duplicate recipients: re-point form records, keep survivor, tombstone loser. */
export async function mergeRecipients(
  db: Db,
  firmId: string,
  survivorId: string,
  duplicateId: string,
  changedBy: string,
): Promise<{ movedForms: number }> {
  if (survivorId === duplicateId) throw AppError.validation('Cannot merge a recipient into itself');
  const [survivor, duplicate] = await Promise.all([
    db.query.recipients.findFirst({ where: and(eq(recipients.id, survivorId), eq(recipients.firmId, firmId)) }),
    db.query.recipients.findFirst({ where: and(eq(recipients.id, duplicateId), eq(recipients.firmId, firmId)) }),
  ]);
  if (!survivor || !duplicate) throw AppError.notFound('Recipient');
  if (duplicate.mergedIntoId) throw AppError.state('Recipient is already merged');

  // Only unfiled, editable records may follow the survivor. Anything already
  // transmitted/accepted/corrected — or queued and claimed by a transmission —
  // was filed under the DUPLICATE's TIN: re-pointing it would rewrite the
  // as-filed identity behind Copy B reprints, the recipient-portal last-4
  // challenge and the correction diff while the IRS still holds the old TIN.
  const filed = await db
    .select({ id: formRecords.id })
    .from(formRecords)
    .where(
      and(
        eq(formRecords.recipientId, duplicateId),
        or(notInArray(formRecords.status, ['draft', 'ready', 'rejected']), isNotNull(formRecords.transmissionId)),
      ),
    );
  if (filed.length) {
    throw AppError.state(
      `This recipient has ${filed.length} filed or in-flight form(s) — a TIN change on a filed return is a Type 2 correction, not a merge. Only draft/ready/rejected forms can be merged.`,
    );
  }

  const moved = await db
    .update(formRecords)
    .set({ recipientId: survivorId, updatedAt: new Date() })
    .where(and(eq(formRecords.recipientId, duplicateId), isNull(formRecords.transmissionId)))
    .returning({ id: formRecords.id });

  await db.update(recipients).set({ mergedIntoId: survivorId, updatedAt: new Date() }).where(eq(recipients.id, duplicateId));
  await db.insert(recipientAddressHistory).values({
    recipientId: survivorId,
    name1: survivor.name1,
    name2: survivor.name2,
    address: survivor.address,
    source: 'merge',
    changedBy,
  });

  return { movedForms: moved.length };
}

/** Reveal full TIN (staff, audited at the route). */
export async function revealTin(db: Db, firmId: string, id: string): Promise<string> {
  const row = await db.query.recipients.findFirst({ where: and(eq(recipients.id, id), eq(recipients.firmId, firmId)) });
  if (!row) throw AppError.notFound('Recipient');
  return getCrypto().decrypt(row.tinEncrypted);
}

export { getDb };
