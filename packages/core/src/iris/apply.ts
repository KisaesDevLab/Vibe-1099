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
    const translated = recErrors.map((e) => ({
      code: e.code,
      message: e.message,
      translated: tmap.get(e.code)
        ? `${tmap.get(e.code)!.plainEnglish} ${tmap.get(e.code)!.suggestedFix}`.trim()
        : undefined,
    }));
    // An error row without a disposition is treated as a rejection (legacy /
    // providers that do not distinguish); an explicit 'accepted_with_errors'
    // means the agency HAS the return.
    const rejected = overall === 'rejected' || recErrors.some((e) => (e.disposition ?? 'rejected') === 'rejected');
    if (rejected) {
      await db
        .update(formRecords)
        .set({
          status: 'rejected',
          // Release the transmission link: a rejected record was never accepted,
          // so it is corrected by editing and re-filing as a fresh original. The
          // compose guard blocks records still bound to a transmission, so leaving
          // this set would make rejected records permanently unfileable (§6721).
          transmissionId: null,
          recordErrors: translated,
          updatedAt: new Date(),
        })
        .where(eq(formRecords.id, r.id));
    } else if (recErrors.length) {
      // Accepted with errors: the IRS filed it. It LOCKS like an accepted record
      // (keeps its transmission link + as-filed snapshot) and is repaired through
      // the corrections path — re-queuing it as an original would file a duplicate.
      await db
        .update(formRecords)
        .set({ status: 'accepted_with_errors', recordErrors: translated, updatedAt: new Date() })
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
