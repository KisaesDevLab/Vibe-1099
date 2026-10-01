/**
 * Assigned preparer — each payer can carry the staff user responsible for it
 * (payers.preparer_id). List endpoints accept `preparerId=<user id>|none` and
 * narrow to that preparer's payers ('none' = unassigned).
 */
import { and, eq, isNull, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '@vibe1099/shared';
import { getDb, payers, users } from '@vibe1099/db';

export const zPreparerFilter = z.union([z.string().uuid(), z.literal('none')]).optional();

/** Condition restricting a payer-id column to the filtered preparer's payers. */
export function preparerCond(firmId: string, filter: string, payerIdCol: AnyColumn): SQL {
  const sub = getDb()
    .select({ id: payers.id })
    .from(payers)
    .where(and(eq(payers.firmId, firmId), filter === 'none' ? isNull(payers.preparerId) : eq(payers.preparerId, filter)));
  return sql`${payerIdCol} IN ${sub}`;
}

/** A preparer must be an active staff user of the same firm. */
export async function assertPreparer(firmId: string, userId: string): Promise<void> {
  const user = await getDb().query.users.findFirst({ where: and(eq(users.id, userId), eq(users.firmId, firmId)) });
  if (!user || !user.active) throw AppError.validation('Preparer must be an active staff user.');
}
