/**
 * Filing-provider resolution (Tax1099 Phase 1).
 *
 * Provider is chosen per-payer, falling back to the firm default. IRIS config
 * (TCC/JWK) is only required for IRIS payers; Tax1099 payers need only the
 * firm's Tax1099 app key — so an entity can e-file with NO IRS TCC of its own.
 *
 * Client/config construction (credential decrypt, §7216 gates, mock/sandbox/prod
 * URLs) lives in @vibe1099/core (filing/resolve.ts) so the API and the worker
 * share ONE implementation; the names are re-exported here for existing callers.
 */
import { and, eq } from 'drizzle-orm';
import { AppError, type FilingProviderKind } from '@vibe1099/shared';
import { firms, formRecords, payers, transmissions, type Db } from '@vibe1099/db';

export {
  buildTax1099Client,
  buildTaxBanditsClient,
  loadTax1099Config,
  loadTaxBanditsConfig,
  type Tax1099Config,
  type TaxBanditsConfig,
} from '@vibe1099/core';

export async function resolveProviderKind(db: Db, firmId: string, payerId: string): Promise<FilingProviderKind> {
  const [firm, payer] = await Promise.all([
    db.query.firms.findFirst({ where: eq(firms.id, firmId) }),
    db.query.payers.findFirst({ where: and(eq(payers.id, payerId), eq(payers.firmId, firmId)) }),
  ]);
  if (!firm || !payer) throw AppError.notFound('Payer');
  return (payer.filingProviderOverride ?? firm.filingProvider) as FilingProviderKind;
}

/**
 * Corrections affinity (addendum §2.3, hard invariant): a correction/void MUST
 * transmit through the SAME provider as the original filing. Given the correction
 * records queued for a batch, resolve the provider from the original transmission
 * they descend from (via correctsId → original record → its transmission). Throws
 * if the queued corrections descend from more than one provider. An original with
 * no transmission link contributes nothing — never a guess from "the firm's most
 * recent transmission", which could route a correction to the wrong provider.
 */
export async function resolveCorrectionProvider(
  db: Db,
  firmId: string,
  correctionRecordIds: string[],
): Promise<FilingProviderKind | null> {
  const providers = new Set<FilingProviderKind>();
  for (const id of correctionRecordIds) {
    const rec = await db.query.formRecords.findFirst({ where: and(eq(formRecords.id, id), eq(formRecords.firmId, firmId)) });
    if (!rec?.correctsId) continue;
    // walk to the head original, then find the transmission that filed it
    let originalId: string | null = rec.correctsId;
    let guard = 0;
    let original = await db.query.formRecords.findFirst({ where: eq(formRecords.id, originalId) });
    while (original?.correctsId && guard++ < 10) {
      originalId = original.correctsId;
      original = await db.query.formRecords.findFirst({ where: eq(formRecords.id, originalId) });
    }
    if (!original?.transmissionId) continue;
    const tx = await db.query.transmissions.findFirst({ where: eq(transmissions.id, original.transmissionId) });
    if (tx) providers.add(tx.provider as FilingProviderKind);
  }
  if (providers.size > 1) {
    throw AppError.conflict('These corrections descend from filings on different providers — file them in separate batches (corrections stay on the original provider).');
  }
  return providers.size === 1 ? [...providers][0]! : null;
}
