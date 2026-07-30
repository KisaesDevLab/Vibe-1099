/**
 * TaxBandits prepaid-credit cost ledger (addendum §2.6 / Phase TB-H).
 *
 * Single source of truth for billable TaxBandits events, shared by the API
 * (TIN-match submit) and the worker (e-file/correction ack). Every write goes
 * through `recordCost`, which persists an integer-cents ledger row AND an
 * append-only audit entry, attributed firm → payer → transmission → form so firms
 * can rebill clients. Rates are contract-negotiated (not the retail sheet), so the
 * authoritative charge is the prepaid-balance delta the API reports on each event;
 * per-event amounts are otherwise supplied by the caller.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { firms, taxbanditsCostLedger, type Db } from '@vibe1099/db';
import { audit } from '../audit.js';
import { notify } from '../notify.js';

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

/** Persist a billable event (ledger row + audit entry). */
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

/** Latest known post-event prepaid balance for a firm, if the API ever reported one. */
export async function latestBalanceCents(db: Db, firmId: string): Promise<number | null> {
  const [row] = await db
    .select({ balance: taxbanditsCostLedger.balanceAfterCents })
    .from(taxbanditsCostLedger)
    .where(and(eq(taxbanditsCostLedger.firmId, firmId), sql`${taxbanditsCostLedger.balanceAfterCents} IS NOT NULL`))
    .orderBy(desc(taxbanditsCostLedger.createdAt))
    .limit(1);
  return row?.balance ?? null;
}

/** Sum of all ledger charges for a firm (integer cents). */
export async function firmSpendCents(db: Db, firmId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`COALESCE(SUM(${taxbanditsCostLedger.amountCents}), 0)` })
    .from(taxbanditsCostLedger)
    .where(eq(taxbanditsCostLedger.firmId, firmId));
  return Number(row?.total ?? 0);
}

/** Emit a low-balance notification (email/in-app — TCPA-safe) if below threshold. */
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
