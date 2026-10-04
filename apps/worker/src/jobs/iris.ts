/**
 * IRIS worker (Phase 9): transmit (POST intake, capture Receipt ID) and ack
 * polling (exponential backoff, terminal-state handling, partial acceptance).
 * Alerting: transmission failures → staff email.
 */
import { and, count, eq, notInArray } from 'drizzle-orm';
import { Job } from 'bullmq';
import {
  buildFilingProvider,
  checkLowBalance,
  createLogger,
  getBlob,
  getQueue,
  latestBalanceCents,
  putBlob,
  QUEUE_NAMES,
  recordCost,
  Tax1099Client,
  TaxBanditsClient,
  type DeliveryJob,
  type FilingProvider,
  type FilingProviderKind,
  type FilingStatusResult,
  type IrisPollJob,
  type IrisTransmitJob,
} from '@vibe1099/core';
import { applyAckToRecords, audit, notify, type RecordError } from '@vibe1099/core';
import { deliveries, firms, formRecords, getDb, transmissions, users } from '@vibe1099/db';

const log = createLogger('worker:iris');

const POLL_DELAYS_MS = [60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000]; // exp backoff → hourly
const MAX_POLLS = 96; // ~4 days at terminal cadence
const POLL_ERROR_ALERT_AT = 6; // consecutive unreachable-provider polls before staff hear about it (~1h on the ladder)

/**
 * The FilingProvider a transmission targets — the SAME builders (credentials,
 * §7216 gates, mock/sandbox/prod URLs) the API uses, from @vibe1099/core.
 */
export function providerFor(firmId: string, kind: FilingProviderKind): Promise<FilingProvider> {
  return buildFilingProvider(getDb(), firmId, kind);
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
  // ONLY a freshly composed transmission may be sent. A 'failed' one must never be
  // re-driven from the queue (admin "retry failed" / manual Job.retry): its records
  // were released and may already be inside a newer transmission, so re-POSTing
  // the stale blob would file the same returns twice (§6721). A failed
  // transmission is retried by composing a new one.
  if (tx.status !== 'building') {
    log.warn({ tx: tx.id, status: tx.status }, 'transmit skipped — not in building state (duplicate guard)');
    return;
  }
  if (!tx.xmlBlobId) throw new Error('transmission has no XML');
  // The blob is only safe to send while every record it was built from is still
  // bound to this transmission; anything else means the records were released.
  const [linked] = await db.select({ n: count() }).from(formRecords).where(eq(formRecords.transmissionId, tx.id));
  const linkedCount = Number(linked?.n ?? 0);
  if (linkedCount !== tx.recordCount) {
    log.error({ tx: tx.id, expected: tx.recordCount, linked: linkedCount }, 'transmit aborted — records no longer bound to this transmission');
    await db
      .update(transmissions)
      .set({
        status: 'failed',
        errorDetails: [{ recordId: '', code: 'TRANSMIT_ABORTED', message: `Expected ${tx.recordCount} bound record(s) but found ${linkedCount} — the records were released; compose a fresh transmission` }],
      })
      .where(eq(transmissions.id, tx.id));
    return;
  }
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
      const details = (err as { details?: { recordErrors?: RecordError[]; transport?: boolean } }).details;
      if (details?.transport === true) {
        // No answer from the provider (timeout / lost response): the submission
        // MAY have been received. Unlinking the records here would let the next
        // compose mint a fresh UTID and file the same returns twice (§6721), so
        // they stay bound to this failed transmission until an operator confirms
        // with the provider and releases them (Transmissions → Release records).
        const message = `${(err as Error).message} — no answer from the provider; the submission MAY have been received. Confirm with the provider before releasing these records for a fresh transmit.`;
        await db
          .update(transmissions)
          .set({ status: 'failed', errorDetails: [{ recordId: '', code: 'TRANSMIT_UNCONFIRMED', message }] })
          .where(eq(transmissions.id, tx.id));
        await audit(db, {
          firmId: data.firmId,
          actorType: 'system',
          action: 'transmission.unconfirmed',
          entityType: 'transmission',
          entityId: tx.id,
          detail: { utid: tx.utid, provider: tx.provider },
        });
        await alertStaff(
          data.firmId,
          'IRIS transmission unconfirmed',
          `Transmission ${tx.utid} got no answer from the provider — it may or may not have been received. Its records stay bound to it: confirm with the provider, then release them from the transmission log before re-transmitting.`,
        );
        throw err;
      }
      // Providers reject per record (TaxBandits returns ErrorRecords on a 400
      // Create). Persist those so the operator sees WHICH payee failed and why
      // instead of a bare HTTP status; fall back to the summary message.
      const recordErrors = details?.recordErrors ?? [];
      const errorDetails = recordErrors.length
        ? [
            { recordId: '', code: 'TRANSMIT_FAILED', message: (err as Error).message },
            ...recordErrors.map((e) => ({ recordId: e.recordId, code: e.code, message: e.message })),
          ]
        : [{ recordId: '', code: 'TRANSMIT_FAILED', message: (err as Error).message }];
      await db
        .update(transmissions)
        // Same shape as per-record ack errors (recordId empty = whole submission)
        // so every consumer can read one structure.
        .set({ status: 'failed', errorDetails })
        .where(eq(transmissions.id, tx.id));
      // Attach the reasons to the records themselves so they surface on the
      // forms grid, not just in the transmission log.
      for (const e of recordErrors) {
        if (!e.recordId) continue;
        await db
          .update(formRecords)
          .set({ recordErrors: [{ code: e.code, message: e.message }], updatedAt: new Date() })
          .where(eq(formRecords.id, e.recordId));
      }
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

  const reschedule = async (extra: Partial<IrisPollJob>): Promise<void> => {
    if (data.attempt + 1 >= MAX_POLLS) {
      await alertStaff(data.firmId, 'IRIS ack polling stalled', `Transmission ${tx.utid} (Receipt ${tx.receiptId}) still processing after ${MAX_POLLS} polls — check IRIS status manually.`);
      return;
    }
    const delay = POLL_DELAYS_MS[Math.min(data.attempt + 1, POLL_DELAYS_MS.length - 1)];
    await getQueue(QUEUE_NAMES.iris).add('poll', { ...data, attempt: data.attempt + 1, consecutiveErrors: 0, ...extra }, { delay });
  };

  // A status call that throws (provider 5xx/maintenance page, open circuit
  // breaker, config drift) must keep the poll chain alive on the same backoff
  // ladder — letting the queue's few retries exhaust would strand the
  // transmission in 'polling' forever with nobody told.
  let result: FilingStatusResult;
  try {
    const provider = await providerFor(data.firmId, tx.provider);
    // TaxBandits status endpoints are per form type — derive it from the
    // transmission's records (compose enforces a single type per submission).
    let formType: string | undefined;
    if (tx.provider === 'taxbandits') {
      const rec = await db.query.formRecords.findFirst({ where: eq(formRecords.transmissionId, tx.id) });
      formType = rec?.formType;
    }
    result = await provider.status(tx.receiptId, formType ? { formType } : undefined);
  } catch (err) {
    const consecutiveErrors = (data.consecutiveErrors ?? 0) + 1;
    log.warn({ tx: tx.id, err: (err as Error).message, consecutiveErrors }, 'ack poll could not get a status from the provider — rescheduling');
    if (consecutiveErrors === POLL_ERROR_ALERT_AT) {
      await alertStaff(data.firmId, 'IRIS ack polling cannot reach the provider', `Transmission ${tx.utid} (Receipt ${tx.receiptId}): ${consecutiveErrors} status checks in a row failed (${(err as Error).message}). Polling continues; check the provider's service status.`);
    }
    await reschedule({ consecutiveErrors });
    return;
  }

  if (result.status === 'Processing' || result.status === 'NotFound') {
    // A TaxBandits submission still staged (every record CREATED) after several
    // polls means the mandatory Transmit/release keeps failing (credits, provider
    // console) — say so instead of a silent 4-day wait for the stall alert.
    const staged = !!result.records?.length && result.records.every((r) => r.status.toUpperCase() === 'CREATED');
    if (staged && data.attempt === 2) {
      await alertStaff(data.firmId, 'Submission not released at the provider', `Transmission ${tx.utid} (Submission ${tx.receiptId}) is still staged (CREATED) after ${data.attempt + 1} status checks — the provider's Transmit/release step keeps failing. Check prepaid credits and the provider console; polling continues.`);
    }
    await reschedule({});
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
      const prev = await latestBalanceCents(db, data.firmId);
      const amountCents = balance && prev != null ? Math.max(0, prev - balance.balanceCents) : 0;
      // the shared, AUDITED ledger write (every charge gets its append-only audit row)
      await recordCost(db, {
        firmId: data.firmId,
        transmissionId: tx.id,
        eventType: tx.isCorrection ? 'correction' : 'efile',
        amountCents,
        balanceAfterCents: balance?.balanceCents ?? null,
        detail: { utid: tx.utid, recordCount: tx.recordCount },
      });
      if (balance) await checkLowBalance(db, data.firmId, balance.balanceCents);
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
    await alertStaff(data.firmId, 'IRIS accepted with errors', `Transmission ${tx.utid}: ${result.errors.length} record error(s) — rejected records are back in the queue to edit; accepted-with-errors records need a correction. See the exception queue.`);
  }
}
