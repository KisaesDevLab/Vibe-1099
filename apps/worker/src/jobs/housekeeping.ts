/**
 * Housekeeping worker (Phases 7/8/12): W-9 request expiry + scheduled
 * reminders, stale-W-9 detection, data-retention sweep for expired blobs.
 */
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { Job } from 'bullmq';
import {
  audit,
  createLogger,
  getCrypto,
  getQueue,
  loadEnv,
  QUEUE_NAMES,
  TaxBanditsClient,
  type DeliveryJob,
} from '@vibe1099/core';
import { appSettings, blobs, firms, getDb, recipients, tinMatchResults, w9Requests } from '@vibe1099/db';
import { providerFor } from './iris.js';

const log = createLogger('worker:housekeeping');

async function settingNumber(key: string, fallback: number): Promise<number> {
  const row = await getDb().query.appSettings.findFirst({ where: eq(appSettings.key, key) });
  return typeof row?.value === 'number' ? (row.value as number) : fallback;
}

async function settingArray(key: string, fallback: number[]): Promise<number[]> {
  const row = await getDb().query.appSettings.findFirst({ where: eq(appSettings.key, key) });
  return Array.isArray(row?.value) ? (row.value as number[]) : fallback;
}

/** Expire overdue W-9 requests. */
async function expireW9Requests(): Promise<void> {
  const db = getDb();
  const expired = await db
    .update(w9Requests)
    .set({ status: 'expired' })
    .where(and(inArray(w9Requests.status, ['sent', 'opened']), lt(w9Requests.expiresAt, new Date())))
    .returning({ id: w9Requests.id });
  if (expired.length) log.info({ count: expired.length }, 'w9 requests expired');
}

/** Scheduled W-9 reminders (configurable day offsets). */
async function sendW9Reminders(): Promise<void> {
  const db = getDb();
  const env = loadEnv();
  const crypto = getCrypto();
  const reminderDays = await settingArray('w9_reminder_days', [7, 14, 21]);
  const open = await db
    .select()
    .from(w9Requests)
    .where(inArray(w9Requests.status, ['sent', 'opened']));

  for (const r of open) {
    const ageDays = Math.floor((Date.now() - r.createdAt.getTime()) / 86_400_000);
    const due = reminderDays.filter((d) => d <= ageDays).length;
    if (due <= r.remindersSent) continue;
    // reissue token so reminders always carry a working link
    const token = crypto.signScopedToken('w9', r.id, r.expiresAt);
    await db
      .update(w9Requests)
      .set({ tokenHash: crypto.tokenHash(token), remindersSent: r.remindersSent + 1, lastReminderAt: new Date() })
      .where(eq(w9Requests.id, r.id));
    const firm = await db.query.firms.findFirst({ where: eq(firms.id, r.firmId) });
    const vars = {
      firmName: firm?.name ?? '',
      link: `${env.PORTAL_BASE_URL}/w9/${encodeURIComponent(token)}`,
      expires: r.expiresAt.toISOString().slice(0, 10),
    };
    const channel: 'email' | 'sms' | null = r.email ? 'email' : r.mobile ? 'sms' : null;
    if (!channel) continue;
    const job: DeliveryJob = {
      kind: 'w9_reminder',
      channel,
      firmId: r.firmId,
      to: channel === 'email' ? (r.email as string) : (r.mobile as string),
      templateKey: 'w9_reminder',
      vars,
      w9RequestId: r.id,
    };
    await getQueue(QUEUE_NAMES.delivery).add('w9_reminder', job);
    log.info({ w9: r.id, reminder: r.remindersSent + 1 }, 'w9 reminder queued');
  }
}

/** Stale W-9 detection (> configurable years). */
async function markStaleW9s(): Promise<void> {
  const db = getDb();
  const staleYears = await settingNumber('w9_stale_years', 3);
  const cutoff = new Date(Date.now() - staleYears * 365.25 * 86_400_000);
  const marked = await db
    .update(recipients)
    .set({ w9Status: 'stale', updatedAt: new Date() })
    .where(and(eq(recipients.w9Status, 'on_file'), lt(recipients.w9CompletedAt, cutoff), isNull(recipients.mergedIntoId)))
    .returning({ id: recipients.id });
  if (marked.length) log.info({ count: marked.length }, 'stale W-9s marked');
}

/**
 * Retention sweep: delete blobs older than the configured retention window
 * (4-year minimum default — never below the §6501 filing-record floor). Covers
 * both derived artifacts and the TIN-bearing filing artifacts (W-9/form PDFs,
 * IRIS XML/acks, Tax1099 payloads, MO .txt) so the appliance actually satisfies
 * FTC Safeguards 314.4(c)(6) secure disposal rather than retaining PII forever.
 * The deletion is audited (append-only) as a system action.
 */
async function retentionSweep(): Promise<void> {
  const db = getDb();
  const env = loadEnv();
  const years = Math.max(4, await settingNumber('data_retention_years', env.DATA_RETENTION_YEARS));
  const cutoff = new Date(Date.now() - years * 365.25 * 86_400_000);
  const deleted = await db
    .delete(blobs)
    .where(
      and(
        lt(blobs.createdAt, cutoff),
        sql`${blobs.kind} IN ('batch_pdf','report_pdf','export_zip','w9_pdf','form_pdf','iris_xml','iris_ack','tax1099_payload','mo_txt')`,
      ),
    )
    .returning({ id: blobs.id });
  if (deleted.length) {
    log.info({ count: deleted.length, years }, 'retention sweep removed expired blobs');
    await audit(db, {
      actorType: 'system',
      action: 'retention.sweep',
      entityType: 'blob',
      detail: { deletedCount: deleted.length, retentionYears: years },
    });
  }
}

/**
 * Short-horizon purge of GENERATED documents (operator-set days, Settings →
 * Advanced). Limited to artifacts that can be regenerated on demand from the
 * records: print batches, report PDFs, export zips, and archived form PDFs
 * (recipient portal copies are rendered per request, so purging a stored form
 * PDF never breaks a recipient's link).
 *
 * Still NOT touched here, by design: signed W-9 PDFs (not regenerable — the
 * recipient's signature exists only in that file) and the filing evidence
 * itself (IRIS XML + acks, provider payloads, MO .txt), which carry a
 * multi-year retention floor (§6501, Pub 4557) and are disposed of only by the
 * years-based retention sweep above. 0 / unset = disabled.
 */
const PURGEABLE_KINDS = ['batch_pdf', 'report_pdf', 'export_zip', 'form_pdf'] as const;

async function purgeGeneratedDocuments(): Promise<void> {
  const db = getDb();
  const days = await settingNumber('document_retention_days', 0);
  if (!days || days < 1) return;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const deleted = await db
    .delete(blobs)
    .where(and(lt(blobs.createdAt, cutoff), inArray(blobs.kind, [...PURGEABLE_KINDS])))
    .returning({ id: blobs.id });
  if (deleted.length) {
    log.info({ count: deleted.length, days }, 'generated-document purge removed expired PDFs/zips');
    await audit(db, {
      actorType: 'system',
      action: 'documents.purge',
      entityType: 'blob',
      detail: { deletedCount: deleted.length, retentionDays: days, kinds: PURGEABLE_KINDS },
    });
  }
}

/**
 * Poll pending TaxBandits TIN-match submissions for their Success/Failed verdict
 * (async batch — up to 24h). Groups open pending rows by (firm, submission) to
 * minimize calls; on a mismatch, flags the recipient's W-9 status stale.
 */
async function pollPendingTinMatches(): Promise<void> {
  const db = getDb();
  const pending = await db
    .select()
    .from(tinMatchResults)
    .where(and(eq(tinMatchResults.provider, 'taxbandits'), eq(tinMatchResults.status, 'pending'), eq(tinMatchResults.stale, false)));
  if (!pending.length) return;

  // group by firm + submission
  const bySubmission = new Map<string, typeof pending>();
  for (const row of pending) {
    if (!row.submissionRef) continue;
    const key = `${row.firmId}::${row.submissionRef}`;
    const list = bySubmission.get(key) ?? [];
    list.push(row);
    bySubmission.set(key, list);
  }

  for (const [key, rows] of bySubmission) {
    const [firmId, submissionRef] = key.split('::');
    try {
      const provider = await providerFor(firmId!, 'taxbandits');
      if (!(provider instanceof TaxBanditsClient)) continue;
      const verdicts = await provider.getTinMatchStatus(submissionRef!);
      for (const row of rows) {
        const v = verdicts.find((x) => x.recordId === row.recordRef || x.recipientRef === row.recipientId);
        if (!v || v.status === 'pending') continue;
        await db
          .update(tinMatchResults)
          .set({ status: v.status, code: v.rawStatus, message: `IRS TIN matching: ${v.rawStatus}`, checkedAt: new Date() })
          .where(eq(tinMatchResults.id, row.id));
        if (v.status === 'mismatch') {
          await db
            .update(recipients)
            .set({ w9Status: 'stale', updatedAt: new Date() })
            .where(and(eq(recipients.id, row.recipientId), eq(recipients.w9Status, 'on_file')));
        }
      }
    } catch (e) {
      log.warn({ err: (e as Error).message, submissionRef }, 'tin-match status poll failed (will retry next sweep)');
    }
  }
}

export async function handleHousekeepingJob(_job: Job): Promise<void> {
  await expireW9Requests();
  await sendW9Reminders();
  await markStaleW9s();
  await pollPendingTinMatches();
  await purgeGeneratedDocuments();
  await retentionSweep();
}
