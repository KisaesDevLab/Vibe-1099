/**
 * Billing estimate: per-payer activity counts for a tax year, priced by the
 * year's fee schedule (shared/billing.ts holds the pure calculation).
 */
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { computeFees, FORM_TYPES, type BillingCounts, type BillingResult, type FormType } from '@vibe1099/shared';
import { deliveries, formRecords, payers, type Db } from '@vibe1099/db';
import { getBillingSchedule } from './settings.js';

export interface BillingRow extends BillingResult {
  payerId: string;
  payerName: string;
  clientId: string | null;
}

export interface BillingReport {
  taxYear: number;
  schedule: Awaited<ReturnType<typeof getBillingSchedule>>['schedule'];
  scheduleMissing: boolean;
  rows: BillingRow[];
  grandTotal: number;
  /** sum of each payer's net (so it ties to what staff enter per payer) */
  grandNet: number;
}

const isFormType = (t: string): t is FormType => (FORM_TYPES as readonly string[]).includes(t);

export async function buildBillingReport(
  db: Db,
  firmId: string,
  taxYear: number,
  preparerId?: string,
): Promise<BillingReport> {
  const payerConds: SQL[] = [eq(payers.firmId, firmId)];
  if (preparerId) payerConds.push(preparerId === 'none' ? isNull(payers.preparerId) : eq(payers.preparerId, preparerId));

  // Originals: non-draft, correction_seq 0 (a `corrected` original was still filed).
  // Corrections: one per corrected form — the Type 2 "new" record is the second
  // half of a pair whose zeroing record already counts, so it is excluded.
  const typeCounts = await db
    .select({
      payerId: formRecords.payerId,
      payerName: payers.legalName,
      clientId: payers.clientId,
      formType: formRecords.formType,
      originals: sql<number>`count(*) FILTER (WHERE ${formRecords.correctionSeq} = 0)::int`,
      corrections: sql<number>`count(*) FILTER (WHERE ${formRecords.correctionSeq} > 0
        AND ${formRecords.correctionType} IS DISTINCT FROM 'two_transaction_new')::int`,
    })
    .from(formRecords)
    .innerJoin(payers, eq(payers.id, formRecords.payerId))
    .where(and(eq(formRecords.firmId, firmId), eq(formRecords.taxYear, taxYear), sql`${formRecords.status} <> 'draft'`, ...payerConds))
    .groupBy(formRecords.payerId, payers.legalName, payers.clientId, formRecords.formType);

  // every paper mailing actually sent (a re-mailed corrected Copy B counts again)
  const mailCounts = await db
    .select({
      payerId: formRecords.payerId,
      payerName: payers.legalName,
      clientId: payers.clientId,
      mailings: sql<number>`count(*)::int`,
    })
    .from(deliveries)
    .innerJoin(formRecords, eq(formRecords.id, deliveries.formRecordId))
    .innerJoin(payers, eq(payers.id, formRecords.payerId))
    .where(
      and(
        eq(deliveries.firmId, firmId),
        eq(deliveries.channel, 'paper'),
        sql`${deliveries.sentAt} IS NOT NULL`,
        eq(formRecords.taxYear, taxYear),
        ...payerConds,
      ),
    )
    .groupBy(formRecords.payerId, payers.legalName, payers.clientId);

  const byPayer = new Map<string, { payerName: string; clientId: string | null; counts: BillingCounts }>();
  const entry = (r: { payerId: string; payerName: string; clientId: string | null }) => {
    let e = byPayer.get(r.payerId);
    if (!e) {
      e = { payerName: r.payerName, clientId: r.clientId || null, counts: { originals: {}, corrections: {}, mailings: 0 } };
      byPayer.set(r.payerId, e);
    }
    return e;
  };
  for (const r of typeCounts) {
    if (!isFormType(r.formType)) continue;
    const e = entry(r);
    e.counts.originals[r.formType] = r.originals;
    e.counts.corrections[r.formType] = r.corrections;
  }
  for (const r of mailCounts) entry(r).counts.mailings = r.mailings;

  const { schedule, missing } = await getBillingSchedule(taxYear);
  const rows: BillingRow[] = [...byPayer.entries()]
    .map(([payerId, e]) => ({ payerId, payerName: e.payerName, clientId: e.clientId, ...computeFees(e.counts, schedule) }))
    .sort((a, b) => a.payerName.localeCompare(b.payerName));

  return {
    taxYear,
    schedule,
    scheduleMissing: missing,
    rows,
    grandTotal: rows.reduce((s, r) => s + r.total, 0),
    grandNet: rows.reduce((s, r) => s + r.net, 0),
  };
}
