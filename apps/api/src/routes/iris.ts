/**
 * IRIS routes (Phase 9): settings (TCC/ClientID/JWK, env toggle), JWK tooling,
 * batch composer + transmit, transmission log, deadline dashboard, error
 * translation table (admin-editable), Form 8809 guidance.
 */
import { Router } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, deadlinesFor, ErrorCodes, FILING_PROVIDER_KINDS, zTaxYear } from '@vibe1099/shared';
import { generateJwkPair, getBlob, getCrypto, getQueue, loadEnv, QUEUE_NAMES, type IrisTransmitJob } from '@vibe1099/core';
import { errorTranslations, firms, formRecords, getDb, payers, recipients, taxbanditsWebhookEvents, tinMatchResults, transmissions } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { requireStaff } from '../middleware/auth.js';
import { composeTransmission } from '../services/iris.js';
import { buildTaxBanditsClient, buildTax1099Client } from '../services/filing.js';
import { recentWebhookAnomalies } from './taxbandits-webhooks.js';

export const irisRouter = Router();
irisRouter.use(requireStaff());

// --- settings (admin) ----------------------------------------------------------

irisRouter.get(
  '/settings',
  requireStaff('admin'),
  h(async (req, res) => {
    const firm = await getDb().query.firms.findFirst({ where: eq(firms.id, req.staff!.firmId) });
    if (!firm) throw AppError.notFound('Firm');
    res.json({
      tcc: firm.irisTcc,
      apiClientId: firm.irisApiClientId,
      hasJwk: !!firm.irisJwkEncrypted,
      publicJwk: firm.irisJwkPublic,
      environment: firm.irisEnvironment,
      // filing backend
      filingProvider: firm.filingProvider,
      tax1099Environment: firm.tax1099Environment,
      tax1099Mailing: firm.tax1099Mailing,
      hasTax1099Key: !!firm.tax1099ApiKeyEncrypted,
      tax1099DisclosureAckAt: firm.tax1099DisclosureAckAt,
      // TaxBandits backend (always offered; gated per-firm by enable + creds + §7216 ack)
      taxbanditsEnabled: firm.taxbanditsEnabled,
      taxbanditsEnvironment: firm.taxbanditsEnvironment,
      taxbanditsPostalMailing: firm.taxbanditsPostalMailing,
      taxbanditsOnlineAccess: firm.taxbanditsOnlineAccess,
      hasTaxbanditsCreds: !!(firm.taxbanditsClientIdEncrypted && firm.taxbanditsClientSecretEncrypted && firm.taxbanditsUserTokenEncrypted),
      taxbanditsDisclosureAckAt: firm.taxbanditsDisclosureAckAt,
      // webhook setup info (register this URL in the TaxBandits console)
      taxbanditsWebhookUrl: `${loadEnv().PORTAL_BASE_URL.replace(/\/$/, '')}/api/webhooks/taxbandits`,
    });
  }),
);

irisRouter.put(
  '/settings',
  requireStaff('admin'),
  h(async (req, res) => {
    const input = z
      .object({
        tcc: z.string().max(10).optional(),
        apiClientId: z.string().max(100).optional(),
        environment: z.enum(['ATS', 'PROD']).optional(),
        privateJwk: z.record(z.unknown()).optional(), // upload existing JWK
        // filing backend
        filingProvider: z.enum(FILING_PROVIDER_KINDS).optional(),
        tax1099ApiKey: z.string().max(500).optional(),
        tax1099Environment: z.enum(['sandbox', 'production']).optional(),
        tax1099Mailing: z.boolean().optional(),
        // one-time admin acceptance of the §7216 disclosure to Zenwork
        acknowledgeTax1099Disclosure: z.boolean().optional(),
        // TaxBandits backend
        taxbanditsEnabled: z.boolean().optional(),
        taxbanditsClientId: z.string().max(200).optional(),
        taxbanditsClientSecret: z.string().max(500).optional(),
        taxbanditsUserToken: z.string().max(500).optional(),
        taxbanditsEnvironment: z.enum(['sandbox', 'production']).optional(),
        taxbanditsPostalMailing: z.boolean().optional(),
        taxbanditsOnlineAccess: z.boolean().optional(),
        acknowledgeTaxbanditsDisclosure: z.boolean().optional(),
      })
      .parse(req.body);
    const db = getDb();
    const firm = await db.query.firms.findFirst({ where: eq(firms.id, req.staff!.firmId) });
    if (!firm) throw AppError.notFound('Firm');
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.tcc !== undefined) patch['irisTcc'] = input.tcc.toUpperCase();
    if (input.apiClientId !== undefined) patch['irisApiClientId'] = input.apiClientId;
    if (input.environment !== undefined) patch['irisEnvironment'] = input.environment;
    if (input.filingProvider !== undefined) patch['filingProvider'] = input.filingProvider;
    if (input.tax1099Environment !== undefined) patch['tax1099Environment'] = input.tax1099Environment;
    if (input.tax1099Mailing !== undefined) patch['tax1099Mailing'] = input.tax1099Mailing;
    if (input.tax1099ApiKey !== undefined && input.tax1099ApiKey !== '') {
      patch['tax1099ApiKeyEncrypted'] = getCrypto().encrypt(input.tax1099ApiKey);
    }
    // Record the disclosure acknowledgment (only the first time) and audit it as a
    // §7216 disclosure event. Enabling Tax1099 without it leaves filing gated.
    if (input.acknowledgeTax1099Disclosure && !firm.tax1099DisclosureAckAt) {
      patch['tax1099DisclosureAckAt'] = new Date();
      patch['tax1099DisclosureAckBy'] = req.staff!.userId;
    }
    // TaxBandits config
    if (input.taxbanditsEnabled !== undefined) patch['taxbanditsEnabled'] = input.taxbanditsEnabled;
    if (input.taxbanditsEnvironment !== undefined) patch['taxbanditsEnvironment'] = input.taxbanditsEnvironment;
    if (input.taxbanditsPostalMailing !== undefined) patch['taxbanditsPostalMailing'] = input.taxbanditsPostalMailing;
    if (input.taxbanditsOnlineAccess !== undefined) patch['taxbanditsOnlineAccess'] = input.taxbanditsOnlineAccess;
    if (input.taxbanditsClientId) patch['taxbanditsClientIdEncrypted'] = getCrypto().encrypt(input.taxbanditsClientId);
    if (input.taxbanditsClientSecret) patch['taxbanditsClientSecretEncrypted'] = getCrypto().encrypt(input.taxbanditsClientSecret);
    if (input.taxbanditsUserToken) patch['taxbanditsUserTokenEncrypted'] = getCrypto().encrypt(input.taxbanditsUserToken);
    if (input.acknowledgeTaxbanditsDisclosure && !firm.taxbanditsDisclosureAckAt) {
      patch['taxbanditsDisclosureAckAt'] = new Date();
      patch['taxbanditsDisclosureAckBy'] = req.staff!.userId;
    }
    if (input.privateJwk) {
      patch['irisJwkEncrypted'] = getCrypto().encrypt(JSON.stringify(input.privateJwk));
      // derive public JWK (strip private members)
      const pub = { ...input.privateJwk };
      for (const k of ['d', 'p', 'q', 'dp', 'dq', 'qi']) delete pub[k];
      patch['irisJwkPublic'] = pub;
    }
    await db.update(firms).set(patch).where(eq(firms.id, req.staff!.firmId));
    res.locals['audit'] = {
      action: patch['tax1099DisclosureAckAt']
        ? 'tax1099.disclosure.ack'
        : patch['taxbanditsDisclosureAckAt']
          ? 'taxbandits.disclosure.ack'
          : 'iris.settings',
      entityType: 'firm',
      entityId: req.staff!.firmId,
      detail: { fields: Object.keys(patch) },
    };
    res.json({ ok: true });
  }),
);

/** Recent TaxBandits webhook events (admin) — surfaced in Settings for verification. */
irisRouter.get(
  '/taxbandits/webhook-events',
  requireStaff('admin'),
  h(async (_req, res) => {
    const rows = await getDb()
      .select({
        eventType: taxbanditsWebhookEvents.eventType,
        submissionId: taxbanditsWebhookEvents.submissionId,
        status: taxbanditsWebhookEvents.status,
        receivedAt: taxbanditsWebhookEvents.receivedAt,
        processedAt: taxbanditsWebhookEvents.processedAt,
      })
      .from(taxbanditsWebhookEvents)
      .orderBy(desc(taxbanditsWebhookEvents.receivedAt))
      .limit(20);
    res.json({ events: rows, anomalies: recentWebhookAnomalies });
  }),
);

/**
 * Reachability self-test for the webhook URL: the appliance GETs its own PUBLIC
 * webhook address (derived from PORTAL_BASE_URL, never user input), which
 * exercises DNS → Cloudflare edge → tunnel → nginx → API end to end. This is
 * the same round trip TaxBandits' validation ping takes.
 */
irisRouter.post(
  '/taxbandits/webhook-test',
  requireStaff('admin'),
  h(async (_req, res) => {
    const url = `${loadEnv().PORTAL_BASE_URL.replace(/\/$/, '')}/api/webhooks/taxbandits`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const body = (await r.json().catch(() => null)) as { ok?: boolean } | null;
      res.json({ ok: r.ok && body?.ok === true, status: r.status, url });
    } catch (err) {
      res.json({ ok: false, status: 0, url, error: err instanceof Error ? err.message : String(err) });
    }
  }),
);

/** JWK tooling: generate keypair in-app; export public JWK for IRS enrollment. */
irisRouter.post(
  '/settings/generate-jwk',
  requireStaff('admin'),
  h(async (req, res) => {
    const { privateJwk, publicJwk } = await generateJwkPair();
    await getDb()
      .update(firms)
      .set({
        irisJwkEncrypted: getCrypto().encrypt(JSON.stringify(privateJwk)),
        irisJwkPublic: publicJwk,
        updatedAt: new Date(),
      })
      .where(eq(firms.id, req.staff!.firmId));
    res.locals['audit'] = { action: 'iris.jwk-generate', entityType: 'firm', entityId: req.staff!.firmId };
    res.json({ publicJwk });
  }),
);

// --- transmit ----------------------------------------------------------------

irisRouter.post(
  '/transmit',
  requireStaff('admin', 'reviewer'),
  h(async (req, res) => {
    const { payerId, taxYear, recordIds, isCorrection } = z
      .object({
        payerId: z.string().uuid(),
        taxYear: zTaxYear,
        recordIds: z.array(z.string().uuid()).optional(),
        // omitted = let compose infer it from the queued records (originals first,
        // then corrections); never default to "original" for a correction batch
        isCorrection: z.boolean().optional(),
      })
      .parse(req.body);
    const db = getDb();
    const result = await composeTransmission(db, req.staff!.firmId, payerId, taxYear, req.staff!.userId, {
      isCorrection,
      recordIds,
    });
    const job: IrisTransmitJob = { kind: 'transmit', transmissionId: result.transmissionId, firmId: req.staff!.firmId };
    // at-most-once: a filing POST must NOT auto-retry. A lost/timed-out response
    // after the IRS already received the intake would otherwise be re-POSTed and
    // risk a duplicate return (§6721). On failure the operator re-queues
    // deliberately after confirming status. (Ack polling keeps its retries.)
    await getQueue(QUEUE_NAMES.iris).add('transmit', job, { attempts: 1 });
    res.locals['audit'] = { action: 'iris.transmit', entityType: 'transmission', entityId: result.transmissionId, detail: { recordCount: result.recordCount } };
    res.status(202).json(result);
  }),
);

/**
 * Real-time IRS TIN/name matching via Tax1099 (Phase 2 add-on). Decrypts the
 * recipient TIN server-side; only the match verdict crosses back to the client.
 */
irisRouter.post(
  '/tin-match',
  h(async (req, res) => {
    const { recipientId, provider } = z
      .object({ recipientId: z.string().uuid(), provider: z.enum(['tax1099', 'taxbandits']).optional() })
      .parse(req.body);
    const db = getDb();
    const recip = await db.query.recipients.findFirst({
      where: and(eq(recipients.id, recipientId), eq(recipients.firmId, req.staff!.firmId)),
    });
    if (!recip) throw AppError.notFound('Recipient');
    // Pick the provider that is actually CONFIGURED (credentials + §7216 ack),
    // preferring the firm's filing backend — an IRIS-default firm whose payers
    // override to TaxBandits has no Tax1099 key, and "Tax1099 is not configured"
    // would point the operator at the wrong provider.
    const firm = await db.query.firms.findFirst({ where: eq(firms.id, req.staff!.firmId) });
    const tbReady = !!(
      firm?.taxbanditsEnabled &&
      firm.taxbanditsClientIdEncrypted &&
      firm.taxbanditsClientSecretEncrypted &&
      firm.taxbanditsUserTokenEncrypted &&
      firm.taxbanditsDisclosureAckAt
    );
    const t99Ready = !!(firm?.tax1099ApiKeyEncrypted && firm.tax1099DisclosureAckAt);
    const chosen =
      provider ??
      (firm?.filingProvider === 'taxbandits' && tbReady ? 'taxbandits' : t99Ready ? 'tax1099' : tbReady ? 'taxbandits' : null);
    if (!chosen) {
      throw new AppError(
        ErrorCodes.E_IRIS_AUTH,
        'No TIN-matching provider is configured — add Tax1099 or TaxBandits credentials and acknowledge the §7216 disclosure in Settings → E-file',
        409,
      );
    }
    const tin = getCrypto().decrypt(recip.tinEncrypted);
    // supersede any prior open result for this recipient
    await db
      .update(tinMatchResults)
      .set({ stale: true })
      .where(and(eq(tinMatchResults.recipientId, recip.id), eq(tinMatchResults.stale, false)));

    if (chosen === 'taxbandits') {
      // async batch: submit now, poll the verdict later (housekeeping sweep / webhook)
      const client = await buildTaxBanditsClient(db, req.staff!.firmId);
      const sub = await client.submitTinMatch({ sequenceId: recip.id, name: recip.name1, tin, tinType: recip.tinType });
      await db.insert(tinMatchResults).values({
        firmId: req.staff!.firmId,
        recipientId: recip.id,
        provider: 'taxbandits',
        status: sub.status, // usually 'pending' (Order Created)
        code: sub.status,
        message: 'Submitted for IRS TIN matching — verdict typically within 24 hours',
        submissionRef: sub.submissionId,
        recordRef: sub.recordId,
      });
      res.locals['audit'] = { action: 'taxbandits.tin-match', entityType: 'recipient', entityId: recip.id, detail: { submissionId: sub.submissionId } };
      return void res.json({ async: true, status: sub.status, submissionId: sub.submissionId });
    }

    // Tax1099: real-time verdict
    const client = await buildTax1099Client(db, req.staff!.firmId);
    const result = await client.tinMatch(tin, recip.name1, recip.tinType);
    if (!result.match && recip.w9Status !== 'requested') {
      await db.update(recipients).set({ w9Status: 'stale', updatedAt: new Date() }).where(eq(recipients.id, recip.id));
    }
    await db.insert(tinMatchResults).values({
      firmId: req.staff!.firmId,
      recipientId: recip.id,
      provider: 'irs',
      status: result.match ? 'match' : 'mismatch',
      code: result.code,
      message: result.message,
    });
    res.locals['audit'] = { action: 'tax1099.tin-match', entityType: 'recipient', entityId: recip.id, detail: { match: result.match } };
    res.json({ async: false, match: result.match, code: result.code, message: result.message });
  }),
);

// --- transmission log -----------------------------------------------------------

irisRouter.get(
  '/transmissions',
  h(async (req, res) => {
    const q = z
      .object({ taxYear: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(5000).default(500) })
      .parse(req.query);
    const conds = [eq(transmissions.firmId, req.staff!.firmId)];
    if (q.taxYear) conds.push(eq(transmissions.taxYear, q.taxYear));
    const rows = await getDb()
      .select({ t: transmissions, payerName: payers.legalName })
      .from(transmissions)
      .leftJoin(payers, eq(payers.id, transmissions.payerId))
      .where(and(...conds))
      .orderBy(desc(transmissions.createdAt))
      .limit(q.limit); // the screen polls this every 10 s — most recent N, not every season ever filed
    res.json({
      transmissions: rows.map(({ t, payerName }) => ({
        id: t.id,
        payerId: t.payerId,
        payerName: payerName ?? null,
        taxYear: t.taxYear,
        environment: t.environment,
        utid: t.utid,
        receiptId: t.receiptId,
        status: t.status,
        isCorrection: t.isCorrection,
        recordCount: t.recordCount,
        provider: t.provider,
        // null = unknown (pre-0.1.21); [] = explicitly none
        statesFiled: t.statesFiled,
        errorDetails: t.errorDetails,
        transmittedAt: t.transmittedAt,
        resolvedAt: t.resolvedAt,
        createdAt: t.createdAt,
      })),
    });
  }),
);

/** Raw XML / ack download (admin). */
irisRouter.get(
  '/transmissions/:id/xml',
  requireStaff('admin'),
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const tx = await getDb().query.transmissions.findFirst({
      where: and(eq(transmissions.id, id), eq(transmissions.firmId, req.staff!.firmId)),
    });
    if (!tx?.xmlBlobId) throw AppError.notFound('Transmission XML');
    const blob = await getBlob(getDb(), tx.xmlBlobId, req.staff!.firmId);
    if (!blob) throw AppError.notFound('XML blob');
    res.setHeader('content-disposition', `attachment; filename="${tx.utid}.xml"`);
    res.type('application/xml').send(blob.bytes);
  }),
);

irisRouter.get(
  '/transmissions/:id/ack',
  requireStaff('admin'),
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const tx = await getDb().query.transmissions.findFirst({
      where: and(eq(transmissions.id, id), eq(transmissions.firmId, req.staff!.firmId)),
    });
    if (!tx?.ackBlobId) throw AppError.notFound('Acknowledgement');
    const blob = await getBlob(getDb(), tx.ackBlobId, req.staff!.firmId);
    if (!blob) throw AppError.notFound('Ack blob');
    res.setHeader('content-disposition', `attachment; filename="${tx.utid}-ack.xml"`);
    res.type('application/xml').send(blob.bytes);
  }),
);

/**
 * Inline status check (diagnostic for stuck acks): asks the provider RIGHT NOW
 * and returns the derived verdict plus the raw response so the operator can see
 * exactly what the provider is saying. Read-only — a terminal verdict is handed
 * to the normal worker poll path so the ack applies through one code path.
 * Staff-zone: raw provider bodies can echo record refs/names (same exposure as
 * the existing error-details panel). IRIS acks stay worker-side (Poll now).
 */
irisRouter.get(
  '/transmissions/:id/status-check',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const db = getDb();
    const tx = await db.query.transmissions.findFirst({
      where: and(eq(transmissions.id, id), eq(transmissions.firmId, req.staff!.firmId)),
    });
    if (!tx) throw AppError.notFound('Transmission');
    if (!tx.receiptId) throw AppError.state('Transmission has no Receipt ID yet');
    if (tx.provider === 'iris') {
      throw AppError.validation('Inline status check covers Tax1099/TaxBandits — for IRIS use Poll now (the ack applies within a minute).');
    }
    let formType: string | undefined;
    if (tx.provider === 'taxbandits') {
      const rec = await db.query.formRecords.findFirst({ where: eq(formRecords.transmissionId, tx.id) });
      formType = rec?.formType ?? 'NEC';
    }
    const client =
      tx.provider === 'taxbandits' ? await buildTaxBanditsClient(db, req.staff!.firmId) : await buildTax1099Client(db, req.staff!.firmId);
    const result = await client.status(tx.receiptId, formType ? { formType } : undefined);
    const terminal = result.status === 'Accepted' || result.status === 'AcceptedWithErrors' || result.status === 'Rejected';
    if (terminal && tx.status !== 'accepted' && tx.status !== 'accepted_with_errors' && tx.status !== 'rejected') {
      await getQueue(QUEUE_NAMES.iris).add('poll', { kind: 'poll', transmissionId: tx.id, firmId: req.staff!.firmId, attempt: 0 });
    }
    res.locals['audit'] = { action: 'transmission.status_check', entityType: 'transmission', entityId: tx.id, detail: { derived: result.status } };
    res.json({
      provider: tx.provider,
      txStatus: tx.status,
      derived: result.status,
      terminal,
      applying: terminal,
      errors: result.errors.slice(0, 20),
      // per-record provider status makes a "stuck" submission self-explanatory
      // (CREATED = staged not released; scheduledOn = provider holding it)
      records: (result.records ?? []).slice(0, 50),
      scheduledOn: (result.records ?? []).find((r) => r.scheduledOn)?.scheduledOn ?? null,
      raw: result.raw.slice(0, 4000),
    });
  }),
);

/**
 * Backfill which states a transmission filed (admin).
 *
 * Transmissions created before v0.1.21 carry no state-filing history, so their
 * records still appear in the state direct-file paths (MO Pub 1220) even when a
 * provider already filed the state. Recording it here drops them out.
 *
 * Direction of risk: marking a state as filed EXCLUDES those records from the
 * state file, so a wrong entry causes an under-filing. Admin-only, audited, and
 * the response reports how many records it affects so the operator can sanity
 * check before trusting it.
 */
irisRouter.put(
  '/transmissions/:id/states-filed',
  requireStaff('admin'),
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const { states } = z
      .object({
        states: z
          .array(z.string().regex(/^[A-Za-z]{2}$/, 'Use two-letter state codes'))
          .max(60)
          .transform((a) => [...new Set(a.map((s) => s.toUpperCase()))]),
      })
      .parse(req.body);
    const db = getDb();
    const tx = await db.query.transmissions.findFirst({
      where: and(eq(transmissions.id, id), eq(transmissions.firmId, req.staff!.firmId)),
    });
    if (!tx) throw AppError.notFound('Transmission');
    const [{ n: affected } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(formRecords)
      .where(eq(formRecords.transmissionId, id));
    await db.update(transmissions).set({ statesFiled: states }).where(eq(transmissions.id, id));
    res.locals['audit'] = {
      action: 'transmission.states-filed.set',
      entityType: 'transmission',
      entityId: id,
      detail: { before: tx.statesFiled ?? null, after: states, recordsAffected: affected },
    };
    res.json({ ok: true, statesFiled: states, recordsAffected: affected });
  }),
);

/** Re-poll a stuck transmission. */
irisRouter.post(
  '/transmissions/:id/poll',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const tx = await getDb().query.transmissions.findFirst({
      where: and(eq(transmissions.id, id), eq(transmissions.firmId, req.staff!.firmId)),
    });
    if (!tx) throw AppError.notFound('Transmission');
    if (!tx.receiptId) throw AppError.state('Transmission has no Receipt ID yet');
    await getQueue(QUEUE_NAMES.iris).add('poll', { kind: 'poll', transmissionId: id, firmId: req.staff!.firmId, attempt: 0 });
    res.json({ ok: true });
  }),
);

/**
 * Release the records of a FAILED transmission back to the queue (admin, audited).
 * A transport failure (no answer from the provider) keeps records bound to the
 * failed transmission on purpose — the submission may have been received — so
 * re-transmitting is a deliberate operator step taken after confirming with the
 * provider, never an automatic unlink.
 */
irisRouter.post(
  '/transmissions/:id/release',
  requireStaff('admin'),
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const db = getDb();
    const tx = await db.query.transmissions.findFirst({
      where: and(eq(transmissions.id, id), eq(transmissions.firmId, req.staff!.firmId)),
    });
    if (!tx) throw AppError.notFound('Transmission');
    if (tx.status !== 'failed') throw AppError.state('Only a failed transmission can release its records');
    const released = await db
      .update(formRecords)
      .set({ transmissionId: null, updatedAt: new Date() })
      .where(and(eq(formRecords.transmissionId, id), eq(formRecords.status, 'queued')))
      .returning({ id: formRecords.id });
    res.locals['audit'] = { action: 'transmission.release', entityType: 'transmission', entityId: id, detail: { utid: tx.utid, released: released.length } };
    res.json({ ok: true, released: released.length });
  }),
);

// --- deadlines dashboard ----------------------------------------------------------

irisRouter.get(
  '/deadlines/:taxYear',
  h(async (req, res) => {
    const taxYear = zTaxYear.parse(Number(req.params['taxYear']));
    const db = getDb();
    const firmId = req.staff!.firmId;
    const deadlines = deadlinesFor(taxYear);
    const [counts] = await db
      .select({
        total: sql<number>`count(*)::int`,
        unfiled: sql<number>`count(*) FILTER (WHERE status IN ('draft','ready','queued'))::int`,
        transmitted: sql<number>`count(*) FILTER (WHERE status = 'transmitted')::int`,
        accepted: sql<number>`count(*) FILTER (WHERE status IN ('accepted','accepted_with_errors'))::int`,
        rejected: sql<number>`count(*) FILTER (WHERE status = 'rejected')::int`,
        necUnfiled: sql<number>`count(*) FILTER (WHERE form_type = 'NEC' AND status IN ('draft','ready','queued'))::int`,
      })
      .from(formRecords)
      .where(and(eq(formRecords.firmId, firmId), eq(formRecords.taxYear, taxYear)));
    res.json({
      deadlines: {
        recipientFurnish: { date: deadlines.recipientFurnish, note: 'Copy B to recipients (all form types); 1099-NEC IRS e-file is ALSO due Jan 31' },
        irsEfile: { date: deadlines.irsEfile, note: 'IRS e-file deadline for MISC/INT/DIV (NEC was due Jan 31 — no automatic extension)' },
        missouri: { date: deadlines.missouri, note: 'Missouri direct file (Pub 1220) — last day of February' },
      },
      counts,
      extension:
        'Form 8809 requests an extension of time to file information returns and is filed through IRIS. ' +
        'NOTE: 1099-NEC has NO automatic 30-day extension — Form 8809 for NEC requires hardship criteria (line 7).',
    });
  }),
);

// --- error translation table (living, admin-editable) -------------------------------

irisRouter.get(
  '/error-translations',
  h(async (_req, res) => {
    const rows = await getDb().select().from(errorTranslations).orderBy(errorTranslations.code);
    res.json({ translations: rows });
  }),
);

irisRouter.put(
  '/error-translations/:code',
  requireStaff('admin'),
  h(async (req, res) => {
    const code = z.string().min(1).max(50).parse(req.params['code']);
    const input = z
      .object({
        officialText: z.string().max(2000).default(''),
        plainEnglish: z.string().min(1).max(2000),
        suggestedFix: z.string().max(2000).default(''),
      })
      .parse(req.body);
    await getDb()
      .insert(errorTranslations)
      .values({ source: 'IRIS', code, ...input, updatedBy: req.staff!.userId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [errorTranslations.source, errorTranslations.code],
        set: { ...input, updatedBy: req.staff!.userId, updatedAt: new Date() },
      });
    res.locals['audit'] = { action: 'iris.error-translation', entityType: 'error_translation', entityId: code };
    res.json({ ok: true });
  }),
);
