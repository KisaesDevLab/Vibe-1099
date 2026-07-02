/**
 * Apply IRIS ack results to form records (Phase 9): partial acceptance —
 * accepted records lock; rejected records get translated errors + edit path.
 */
import { eq, inArray } from 'drizzle-orm';
import { errorTranslations, formRecords, type Db } from '@vibe1099/db';
import type { RecordError } from './client.js';

export async function applyAckToRecords(
  db: Db,
  transmissionId: string,
  overall: 'accepted' | 'accepted_with_errors' | 'rejected',
  errors: RecordError[],
): Promise<void> {
  const records = await db.select().from(formRecords).where(eq(formRecords.transmissionId, transmissionId));
  const errorsByRecord = new Map<string, RecordError[]>();
  for (const e of errors) {
    const list = errorsByRecord.get(e.recordId) ?? [];
    list.push(e);
    errorsByRecord.set(e.recordId, list);
  }

  // translate error codes via the living table (admin-editable)
  const codes = [...new Set(errors.map((e) => e.code))];
  const translations = codes.length
    ? await db.select().from(errorTranslations).where(inArray(errorTranslations.code, codes))
    : [];
  const tmap = new Map(translations.map((t) => [t.code, t]));

  for (const r of records) {
    const recErrors = errorsByRecord.get(r.id) ?? [];
    if (overall === 'rejected' || recErrors.length) {
      await db
        .update(formRecords)
        .set({
          status: 'rejected',
          recordErrors: recErrors.map((e) => ({
            code: e.code,
            message: e.message,
            translated: tmap.get(e.code)
              ? `${tmap.get(e.code)!.plainEnglish} ${tmap.get(e.code)!.suggestedFix}`.trim()
              : undefined,
          })),
          updatedAt: new Date(),
        })
        .where(eq(formRecords.id, r.id));
    } else {
      // error-free records in a partially-accepted batch lock as accepted
      await db
        .update(formRecords)
        .set({ status: 'accepted', updatedAt: new Date() })
        .where(eq(formRecords.id, r.id));
    }
  }
}
