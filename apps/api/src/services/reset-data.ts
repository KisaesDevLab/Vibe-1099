/**
 * Admin "remove test data" — wipe a firm's operational/filing data so an
 * appliance can move from sandbox/ATS testing to a clean production season.
 *
 * DELETES (firm-scoped): payers, recipients (+ address history), form records,
 * transmissions, deliveries, paper batches, W-9 requests, client invites, state
 * files, filing runs, notifications, TIN-match results, TaxBandits cost ledger,
 * and blobs (all the PDFs/XML/acks). Also clears the TaxBandits webhook event
 * store (transient status artifacts, not firm-scoped).
 *
 * PRESERVES: the firm + its e-file/delivery config, user accounts, app settings,
 * reference data (error translations, states config), year locks, saved views,
 * and the append-only audit log (which records this reset).
 *
 * Runs in one transaction in FK-safe child→parent order, so any failure rolls
 * back cleanly with no partial wipe.
 */
import { eq, sql } from 'drizzle-orm';
import {
  blobs,
  clientInvites,
  deliveries,
  filingRuns,
  formRecords,
  notifications,
  paperBatches,
  payers,
  recipients,
  stateFiles,
  taxbanditsCostLedger,
  taxbanditsWebhookEvents,
  tinMatchResults,
  transmissions,
  w9Requests,
  type Db,
} from '@vibe1099/db';

export interface ResetCounts {
  payers: number;
  recipients: number;
  formRecords: number;
  transmissions: number;
  blobs: number;
}

export async function resetFirmData(db: Db, firmId: string): Promise<ResetCounts> {
  return db.transaction(async (tx) => {
    // children first (FK-safe order)
    await tx.delete(deliveries).where(eq(deliveries.firmId, firmId));
    await tx.execute(sql`DELETE FROM recipient_address_history WHERE recipient_id IN (SELECT id FROM recipients WHERE firm_id = ${firmId})`);
    await tx.delete(tinMatchResults).where(eq(tinMatchResults.firmId, firmId));
    await tx.delete(w9Requests).where(eq(w9Requests.firmId, firmId));

    const forms = await tx.delete(formRecords).where(eq(formRecords.firmId, firmId)).returning({ id: formRecords.id });
    await tx.delete(clientInvites).where(eq(clientInvites.firmId, firmId));
    await tx.delete(stateFiles).where(eq(stateFiles.firmId, firmId));
    await tx.delete(filingRuns).where(eq(filingRuns.firmId, firmId));
    await tx.delete(notifications).where(eq(notifications.firmId, firmId));
    await tx.delete(taxbanditsCostLedger).where(eq(taxbanditsCostLedger.firmId, firmId));
    await tx.delete(taxbanditsWebhookEvents); // transient, not firm-scoped
    await tx.delete(paperBatches).where(eq(paperBatches.firmId, firmId));

    const txns = await tx.delete(transmissions).where(eq(transmissions.firmId, firmId)).returning({ id: transmissions.id });
    const pyrs = await tx.delete(payers).where(eq(payers.firmId, firmId)).returning({ id: payers.id });
    const recs = await tx.delete(recipients).where(eq(recipients.firmId, firmId)).returning({ id: recipients.id });
    const blbs = await tx.delete(blobs).where(eq(blobs.firmId, firmId)).returning({ id: blobs.id });

    return {
      payers: pyrs.length,
      recipients: recs.length,
      formRecords: forms.length,
      transmissions: txns.length,
      blobs: blbs.length,
    };
  });
}
