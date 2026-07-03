/**
 * TaxBandits prepaid-credit cost ledger (addendum §2.6 / Phase TB-H).
 *
 * Every billable TaxBandits event records an integer-cents ledger row attributed
 * to firm → payer → transmission → form so firms can rebill clients. Rates are
 * contract-negotiated (not the retail sheet), so per-event amounts are supplied by
 * config/estimate, not hard-coded.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { audit, notify } from '@vibe1099/core';
import { firms, taxbanditsCostLedger, type Db } from '@vibe1099/db';

export type TbCostEvent = 'efile' | 'correction' | 'void' | 'state_filing' | 'tin_match' | 'postal' | 'online_access';

export interface LedgerEntry {
  firmId: string;
  payerId?: string | null;
  transmissionId?: string | null;
  formRecordId?: string | null;
  eventType: TbCostEvent;
  amountCents: number;
  balanceAfterCents?: number | null;
  detail?: Record<string, unknown>;
}

export async function recordCost(db: Db, entry: LedgerEntry): Promise<void> {
  await db.insert(taxbanditsCostLedger).values({
    firmId: entry.firmId,
    payerId: entry.payerId ?? null,
    transmissionId: entry.transmissionId ?? null,
    formRecordId: entry.formRecordId ?? null,
    eventType: entry.eventType,
    amountCents: entry.amountCents,
    balanceAfterCents: entry.balanceAfterCents ?? null,
    detail: entry.detail ?? null,
  });
  await audit(db, {
    firmId: entry.firmId,
    actorType: 'system',
    action: 'taxbandits.cost',
    entityType: 'taxbandits_cost_ledger',
    entityId: entry.transmissionId ?? null,
    detail: { eventType: entry.eventType, amountCents: entry.amountCents },
  });
}

/** Sum of all ledger charges for a firm (integer cents). */
export async function firmSpendCents(db: Db, firmId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`COALESCE(SUM(${taxbanditsCostLedger.amountCents}), 0)` })
    .from(taxbanditsCostLedger)
    .where(eq(taxbanditsCostLedger.firmId, firmId));
  return Number(row?.total ?? 0);
}

/** Latest known post-event balance for a firm, if the API reported one. */
export async function latestBalanceCents(db: Db, firmId: string): Promise<number | null> {
  const [row] = await db
    .select({ balance: taxbanditsCostLedger.balanceAfterCents })
    .from(taxbanditsCostLedger)
    .where(and(eq(taxbanditsCostLedger.firmId, firmId), sql`${taxbanditsCostLedger.balanceAfterCents} IS NOT NULL`))
    .orderBy(desc(taxbanditsCostLedger.createdAt))
    .limit(1);
  return row?.balance ?? null;
}

/** Emit a low-balance notification (email only — TCPA-safe default) if below threshold. */
export async function checkLowBalance(db: Db, firmId: string, balanceCents: number): Promise<void> {
  const firm = await db.query.firms.findFirst({ where: eq(firms.id, firmId) });
  if (!firm) return;
  if (balanceCents <= firm.taxbanditsLowCreditCents) {
    await notify(db, {
      firmId,
      kind: 'system',
      severity: 'warning',
      title: 'TaxBandits credit balance low',
      body: `Prepaid credit balance is $${(balanceCents / 100).toFixed(2)} — top up to avoid failed filings.`,
      link: '/settings',
      entityType: 'firm',
      entityId: firmId,
    }).catch(() => undefined);
  }
}
