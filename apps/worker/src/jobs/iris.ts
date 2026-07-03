/**
 * IRIS worker (Phase 9): transmit (POST intake, capture Receipt ID) and ack
 * polling (exponential backoff, terminal-state handling, partial acceptance).
 * Alerting: transmission failures → staff email.
 */
import { eq } from 'drizzle-orm';
import { Job } from 'bullmq';
import {
  createLogger,
  getBlob,
  getCrypto,
  getQueue,
  IrisClient,
  irisEndpoints,
  loadEnv,
  putBlob,
  QUEUE_NAMES,
  type DeliveryJob,
  type IrisPollJob,
  type IrisTransmitJob,
} from '@vibe1099/core';
import { applyAckToRecords, notify } from '@vibe1099/core';
import { firms, formRecords, getDb, transmissions, users } from '@vibe1099/db';

const log = createLogger('worker:iris');

const POLL_DELAYS_MS = [60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000]; // exp backoff → hourly
const MAX_POLLS = 96; // ~4 days at terminal cadence

async function clientFor(firmId: string): Promise<IrisClient> {
  const env = loadEnv();
  const db = getDb();
  const firm = await db.query.firms.findFirst({ where: eq(firms.id, firmId) });
  if (!firm?.irisJwkEncrypted) throw new Error('IRIS not configured');
  const base = env.IRIS_MOCK_BASE_URL || (firm.irisEnvironment === 'PROD' ? env.IRIS_PROD_BASE_URL : env.IRIS_ATS_BASE_URL);
  return new IrisClient(irisEndpoints(base), {
    apiClientId: firm.irisApiClientId,
    privateJwk: JSON.parse(getCrypto().decrypt(firm.irisJwkEncrypted)) as Record<string, unknown>,
    tokenUrl: irisEndpoints(base).tokenUrl,
  });
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
    const client = await clientFor(data.firmId);
    const result = await client.transmit(blob.bytes.toString('utf8'));
    await db
      .update(transmissions)
      .set({ status: 'polling', receiptId: result.receiptId, transmittedAt: new Date() })
      .where(eq(transmissions.id, tx.id));
    // mark linked records transmitted
    await db
      .update(formRecords)
      .set({ status: 'transmitted', updatedAt: new Date() })
      .where(eq(formRecords.transmissionId, tx.id));
    log.info({ tx: tx.id, receiptId: result.receiptId }, 'transmitted');

    const pollJob: IrisPollJob = { kind: 'poll', transmissionId: tx.id, firmId: data.firmId, attempt: 0 };
    await getQueue(QUEUE_NAMES.iris).add('poll', pollJob, { delay: POLL_DELAYS_MS[0] });
  } catch (err) {
    const terminal = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (terminal) {
      await db
        .update(transmissions)
        .set({ status: 'failed', errorDetails: [{ error: (err as Error).message }] })
        .where(eq(transmissions.id, tx.id));
      // records return to queued for a fresh compose after fix
      await db
        .update(formRecords)
        .set({ transmissionId: null, updatedAt: new Date() })
        .where(eq(formRecords.transmissionId, tx.id));
      await alertStaff(data.firmId, 'IRIS transmission failed', `Transmission ${tx.utid} failed after retries: ${(err as Error).message}`);
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

  const client = await clientFor(data.firmId);
  const result = await client.status(tx.receiptId);

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
  });
  const overall =
    result.status === 'Accepted' ? 'accepted' : result.status === 'AcceptedWithErrors' ? 'accepted_with_errors' : 'rejected';
  await db
    .update(transmissions)
    .set({
      status: overall,
      ackBlobId,
      ackPayload: { status: result.status, errorCount: result.errors.length },
      errorDetails: result.errors as unknown as Array<Record<string, unknown>>,
      resolvedAt: new Date(),
    })
    .where(eq(transmissions.id, tx.id));

  await applyAckToRecords(db, tx.id, overall, result.errors);
  log.info({ tx: tx.id, status: overall, errors: result.errors.length }, 'ack applied');
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
