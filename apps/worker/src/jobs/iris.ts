/**
 * IRIS worker (Phase 9): transmit (POST intake, capture Receipt ID) and ack
 * polling (exponential backoff, terminal-state handling, partial acceptance).
 * Alerting: transmission failures → staff email.
 */
import { and, desc, eq, isNotNull, notInArray } from 'drizzle-orm';
import { Job } from 'bullmq';
import {
  createLogger,
  getBlob,
  getCrypto,
  getQueue,
  IrisClient,
  IrisFilingProvider,
  irisEndpoints,
  loadEnv,
  putBlob,
  QUEUE_NAMES,
  Tax1099Client,
  tax1099Endpoints,
  TaxBanditsClient,
  taxbanditsEndpoints,
  type DeliveryJob,
  type FilingProvider,
  type FilingProviderKind,
  type IrisPollJob,
  type IrisTransmitJob,
} from '@vibe1099/core';
import { applyAckToRecords, audit, notify } from '@vibe1099/core';
import { deliveries, firms, formRecords, getDb, taxbanditsCostLedger, transmissions, users } from '@vibe1099/db';

const log = createLogger('worker:iris');

const POLL_DELAYS_MS = [60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000]; // exp backoff → hourly
const MAX_POLLS = 96; // ~4 days at terminal cadence

/** Build the FilingProvider a transmission targets (IRIS A2A / Tax1099 / TaxBandits). */
export async function providerFor(firmId: string, kind: FilingProviderKind): Promise<FilingProvider> {
  const env = loadEnv();
  const db = getDb();
  const firm = await db.query.firms.findFirst({ where: eq(firms.id, firmId) });
  if (!firm) throw new Error('firm missing');

  if (kind === 'tax1099') {
    if (!firm.tax1099ApiKeyEncrypted) throw new Error('Tax1099 not configured');
    // §7216 gate — mirror loadTax1099Config: never transmit payee TINs to Zenwork
    // without the recorded admin disclosure acknowledgment.
    if (!firm.tax1099DisclosureAckAt) throw new Error('Tax1099 disclosure not acknowledged');
    const base =
      env.TAX1099_MOCK_BASE_URL ||
      (firm.tax1099Environment === 'production' ? env.TAX1099_PROD_BASE_URL : env.TAX1099_SANDBOX_BASE_URL);
    return new Tax1099Client(tax1099Endpoints(base), { apiKey: getCrypto().decrypt(firm.tax1099ApiKeyEncrypted) });
  }

  if (kind === 'taxbandits') {
    if (!firm.taxbanditsEnabled || !firm.taxbanditsClientIdEncrypted || !firm.taxbanditsClientSecretEncrypted || !firm.taxbanditsUserTokenEncrypted) {
      throw new Error('TaxBandits not configured');
    }
    // §7216 gate — mirror loadTaxBanditsConfig.
    if (!firm.taxbanditsDisclosureAckAt) throw new Error('TaxBandits disclosure not acknowledged');
    const crypto = getCrypto();
    const mock = env.TAXBANDITS_MOCK_BASE_URL;
    const base = mock || (firm.taxbanditsEnvironment === 'production' ? env.TAXBANDITS_PROD_BASE_URL : env.TAXBANDITS_SANDBOX_BASE_URL);
    const oauthUrl = mock
      ? `${mock.replace(/\/$/, '')}/v2/tbsauth`
      : firm.taxbanditsEnvironment === 'production'
        ? env.TAXBANDITS_PROD_OAUTH_URL
        : env.TAXBANDITS_SANDBOX_OAUTH_URL;
    return new TaxBanditsClient(taxbanditsEndpoints(base, oauthUrl), {
      clientId: crypto.decrypt(firm.taxbanditsClientIdEncrypted),
      clientSecret: crypto.decrypt(firm.taxbanditsClientSecretEncrypted),
      userToken: crypto.decrypt(firm.taxbanditsUserTokenEncrypted),
    });
  }

  if (!firm.irisJwkEncrypted) throw new Error('IRIS not configured');
  const base = env.IRIS_MOCK_BASE_URL || (firm.irisEnvironment === 'PROD' ? env.IRIS_PROD_BASE_URL : env.IRIS_ATS_BASE_URL);
  return new IrisFilingProvider(
    new IrisClient(irisEndpoints(base), {
      apiClientId: firm.irisApiClientId,
      privateJwk: JSON.parse(getCrypto().decrypt(firm.irisJwkEncrypted)) as Record<string, unknown>,
      tokenUrl: irisEndpoints(base).tokenUrl,
    }),
  );
}

async function alertStaff(firmId: string, subject: string, message: string): Promise<void> {
  const db = getDb();
  const admins = await db.query.users.findMany({ where: eq(users.firmId, firmId) });
  for (const admin of admins.filter((u) => u.role === 'admin' && u.active)) {
    const job: DeliveryJob = {
      kind: 'staff_alert',
      channel: 'email',
      firmId,
      to: admin.email,
      templateKey: 'staff_alert',
      vars: { subject, message },
    };
    await getQueue(QUEUE_NAMES.delivery).add('staff_alert', job);
  }
}

export async function handleIrisTransmit(job: Job): Promise<void> {
  const data = job.data as IrisTransmitJob;
  const db = getDb();
  const tx = await db.query.transmissions.findFirst({ where: eq(transmissions.id, data.transmissionId) });
  if (!tx) throw new Error('transmission missing');
  if (tx.status !== 'building' && tx.status !== 'failed') {
    log.warn({ tx: tx.id, status: tx.status }, 'transmit skipped — not in building state (duplicate guard)');
    return;
  }
  if (!tx.xmlBlobId) throw new Error('transmission has no XML');
  const blob = await getBlob(db, tx.xmlBlobId, data.firmId);
  if (!blob) throw new Error('XML blob missing');

  await db.update(transmissions).set({ status: 'transmitting' }).where(eq(transmissions.id, tx.id));
  try {
    const provider = await providerFor(data.firmId, tx.provider);
    // TaxBandits corrections/voids go through a distinct endpoint (same ref shape).
    const result =
      provider instanceof TaxBanditsClient && tx.isCorrection
        ? await provider.transmitCorrection(blob.bytes.toString('utf8'))
        : await provider.transmit(blob.bytes.toString('utf8'));
    await db
      .update(transmissions)
      .set({ status: 'polling', receiptId: result.providerRef, transmittedAt: new Date() })
      .where(eq(transmissions.id, tx.id));
    // mark linked records transmitted
    await db
      .update(formRecords)
      .set({ status: 'transmitted', updatedAt: new Date() })
      .where(eq(formRecords.transmissionId, tx.id));
    await audit(db, {
      firmId: data.firmId,
      actorType: 'system',
      action: 'transmission.transmitted',
      entityType: 'transmission',
      entityId: tx.id,
      detail: { utid: tx.utid, provider: tx.provider, receiptId: result.providerRef },
    });
    log.info({ tx: tx.id, receiptId: result.providerRef, provider: tx.provider }, 'transmitted');

    const pollJob: IrisPollJob = { kind: 'poll', transmissionId: tx.id, firmId: data.firmId, attempt: 0 };
    await getQueue(QUEUE_NAMES.iris).add('poll', pollJob, { delay: POLL_DELAYS_MS[0] });
  } catch (err) {
    const terminal = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (terminal) {
      await db
        .update(transmissions)
        // Same shape as per-record ack errors (recordId empty = whole submission)
        // so every consumer can read one structure.
        .set({ status: 'failed', errorDetails: [{ recordId: '', code: 'TRANSMIT_FAILED', message: (err as Error).message }] })
        .where(eq(transmissions.id, tx.id));
      // records return to queued for a fresh compose after fix
      await db
        .update(formRecords)
        .set({ transmissionId: null, updatedAt: new Date() })
        .where(eq(formRecords.transmissionId, tx.id));
      await audit(db, {
        firmId: data.firmId,
        actorType: 'system',
        action: 'transmission.failed',
        entityType: 'transmission',
        entityId: tx.id,
        detail: { utid: tx.utid, provider: tx.provider },
      });
      // error code/count only in the alert — raw provider bodies can echo TIN/name
      // fragments and would then transit the ESP (kept in the transmission log instead).
      await alertStaff(data.firmId, 'IRIS transmission failed', `Transmission ${tx.utid} failed to send. See the transmission log for details.`);
    } else {
      await db.update(transmissions).set({ status: 'building' }).where(eq(transmissions.id, tx.id));
    }
    throw err;
  }
}

export async function handleIrisPoll(job: Job): Promise<void> {
  const data = job.data as IrisPollJob;
  const db = getDb();
  const tx = await db.query.transmissions.findFirst({ where: eq(transmissions.id, data.transmissionId) });
  if (!tx?.receiptId) throw new Error('transmission missing or has no receipt');
  if (tx.status === 'accepted' || tx.status === 'accepted_with_errors' || tx.status === 'rejected') return;

  const provider = await providerFor(data.firmId, tx.provider);
  // TaxBandits status endpoints are per form type — derive it from the
  // transmission's records (compose enforces a single type per submission).
  let formType: string | undefined;
  if (tx.provider === 'taxbandits') {
    const rec = await db.query.formRecords.findFirst({ where: eq(formRecords.transmissionId, tx.id) });
    formType = rec?.formType;
  }
  const result = await provider.status(tx.receiptId, formType ? { formType } : undefined);

  if (result.status === 'Processing' || result.status === 'NotFound') {
    if (data.attempt + 1 >= MAX_POLLS) {
      await alertStaff(data.firmId, 'IRIS ack polling stalled', `Transmission ${tx.utid} (Receipt ${tx.receiptId}) still processing after ${MAX_POLLS} polls — check IRIS status manually.`);
      return;
    }
    const delay = POLL_DELAYS_MS[Math.min(data.attempt + 1, POLL_DELAYS_MS.length - 1)];
    await getQueue(QUEUE_NAMES.iris).add('poll', { ...data, attempt: data.attempt + 1 }, { delay });
    return;
  }

  // terminal state — persist raw ack and apply per-record results
  const ackBlobId = await putBlob(db, {
    firmId: data.firmId,
    kind: 'iris_ack',
    contentType: 'application/xml',
    filename: `${tx.utid}-ack.xml`,
    bytes: Buffer.from(result.raw, 'utf8'),
    encrypt: true,
  });
  const overall =
    result.status === 'Accepted' ? 'accepted' : result.status === 'AcceptedWithErrors' ? 'accepted_with_errors' : 'rejected';
  // Atomically claim the terminal transition so a scheduled poll and a manual
  // re-poll can't both run the mailing/delivery side effects (duplicate USPS
  // copies / Tax1099 billing). Only the poll that flips a still-non-terminal
  // transmission proceeds.
  const claimed = await db
    .update(transmissions)
    .set({
      status: overall,
      ackBlobId,
      ackPayload: { status: result.status, errorCount: result.errors.length },
      errorDetails: result.errors as unknown as Array<Record<string, unknown>>,
      resolvedAt: new Date(),
    })
    .where(and(eq(transmissions.id, tx.id), notInArray(transmissions.status, ['accepted', 'accepted_with_errors', 'rejected'])))
    .returning({ id: transmissions.id });
  if (!claimed.length) {
    log.warn({ tx: tx.id }, 'ack already applied by a concurrent poll — skipping');
    return;
  }

  await applyAckToRecords(db, tx.id, overall, result.errors);
  await audit(db, {
    firmId: data.firmId,
    actorType: 'system',
    action: `transmission.${overall}`,
    entityType: 'transmission',
    entityId: tx.id,
    detail: { utid: tx.utid, provider: tx.provider, errorCount: result.errors.length },
  });
  log.info({ tx: tx.id, status: overall, errors: result.errors.length }, 'ack applied');

  // TaxBandits prepaid-credit ledger: on an accepted submission, poll the credit
  // balance and record a cost-ledger row (amount inferred from the balance delta
  // where the API reports it), then alert if the balance is low. Best-effort.
  if (tx.provider === 'taxbandits' && overall !== 'rejected') {
    try {
      const provider = await providerFor(data.firmId, 'taxbandits');
      const balance = provider instanceof TaxBanditsClient ? await provider.credits() : null;
      const [prev] = await db
        .select({ balance: taxbanditsCostLedger.balanceAfterCents })
        .from(taxbanditsCostLedger)
        .where(and(eq(taxbanditsCostLedger.firmId, data.firmId), isNotNull(taxbanditsCostLedger.balanceAfterCents)))
        .orderBy(desc(taxbanditsCostLedger.createdAt))
        .limit(1);
      const amountCents = balance && prev?.balance != null ? Math.max(0, prev.balance - balance.balanceCents) : 0;
      await db.insert(taxbanditsCostLedger).values({
        firmId: data.firmId,
        transmissionId: tx.id,
        eventType: tx.isCorrection ? 'correction' : 'efile',
        amountCents,
        balanceAfterCents: balance?.balanceCents ?? null,
        detail: { utid: tx.utid, recordCount: tx.recordCount },
      });
      const firm = await db.query.firms.findFirst({ where: eq(firms.id, data.firmId) });
      if (balance && firm && balance.balanceCents <= firm.taxbanditsLowCreditCents) {
        await notify(db, {
          firmId: data.firmId,
          kind: 'system',
          severity: 'warning',
          title: 'TaxBandits credit balance low',
          body: `Prepaid credit balance is $${(balance.balanceCents / 100).toFixed(2)} — top up to avoid failed filings.`,
          link: '/settings',
          entityType: 'firm',
          entityId: data.firmId,
        }).catch(() => undefined);
      }
    } catch (e) {
      log.warn({ err: (e as Error).message, tx: tx.id }, 'taxbandits credit ledger update failed (non-fatal)');
    }
  }

  // Tax1099 add-on: let Zenwork USPS-mail recipient copies for accepted forms
  // (alternative to the local Z-fold path). Best-effort — a mail failure must
  // not undo the accepted ack.
  if (tx.provider === 'tax1099' && overall !== 'rejected' && tx.receiptId) {
    const firm = await db.query.firms.findFirst({ where: eq(firms.id, data.firmId) });
    if (firm?.tax1099Mailing) {
      try {
        const provider = await providerFor(data.firmId, 'tax1099');
        if (provider instanceof Tax1099Client) {
          const mail = await provider.mailRecipients(tx.receiptId);
          // record a paper delivery for each accepted (error-free) form
          const errored = new Set(result.errors.map((e) => e.recordId));
          const recs = await db
            .select({ id: formRecords.id })
            .from(formRecords)
            .where(eq(formRecords.transmissionId, tx.id));
          for (const r of recs) {
            if (errored.has(r.id)) continue;
            await db.insert(deliveries).values({ firmId: data.firmId, formRecordId: r.id, channel: 'paper', sentAt: new Date() });
          }
          log.info({ tx: tx.id, mailId: mail.mailId, mailed: recs.length - errored.size }, 'tax1099 USPS mailing queued');
        }
      } catch (e) {
        log.warn({ err: (e as Error).message, tx: tx.id }, 'tax1099 mailing failed (non-fatal)');
      }
    }
  }
  // best-effort — a notify failure must not skip the staff rejection alert below
  await notify(db, {
    firmId: data.firmId,
    kind: 'transmission',
    severity: overall === 'accepted' ? 'success' : overall === 'rejected' ? 'error' : 'warning',
    title: `IRIS ${overall.replace('_', ' ')}`,
    body: `Transmission ${tx.utid.slice(0, 12)}… — ${result.errors.length} record error(s).`,
    link: '/transmissions',
    entityType: 'transmission',
    entityId: tx.id,
  }).catch((e) => log.warn({ err: (e as Error).message }, 'transmission notify failed (non-fatal)'));

  if (overall === 'rejected') {
    await alertStaff(data.firmId, 'IRIS transmission rejected', `Transmission ${tx.utid} was rejected. ${result.errors.length} record error(s) — see the transmission log.`);
  } else if (result.errors.length) {
    await alertStaff(data.firmId, 'IRIS accepted with errors', `Transmission ${tx.utid}: ${result.errors.length} record(s) rejected — see the exception queue.`);
  }
}
