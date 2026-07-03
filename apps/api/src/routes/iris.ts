/**
 * IRIS routes (Phase 9): settings (TCC/ClientID/JWK, env toggle), JWK tooling,
 * batch composer + transmit, transmission log, deadline dashboard, error
 * translation table (admin-editable), Form 8809 guidance.
 */
import { Router } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, deadlinesFor, zTaxYear } from '@vibe1099/shared';
import { generateJwkPair, getBlob, getCrypto, getQueue, loadEnv, QUEUE_NAMES, type IrisTransmitJob } from '@vibe1099/core';
import { errorTranslations, firms, formRecords, getDb, recipients, tinMatchResults, transmissions } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { requireStaff } from '../middleware/auth.js';
import { composeTransmission } from '../services/iris.js';
import { buildTaxBanditsClient, buildTax1099Client } from '../services/filing.js';

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
      // TaxBandits backend
      taxbanditsAvailable: loadEnv().TAXBANDITS_ENABLED === 1,
      taxbanditsEnabled: firm.taxbanditsEnabled,
      taxbanditsEnvironment: firm.taxbanditsEnvironment,
      taxbanditsPostalMailing: firm.taxbanditsPostalMailing,
      taxbanditsOnlineAccess: firm.taxbanditsOnlineAccess,
      hasTaxbanditsCreds: !!(firm.taxbanditsClientIdEncrypted && firm.taxbanditsClientSecretEncrypted && firm.taxbanditsUserTokenEncrypted),
      taxbanditsDisclosureAckAt: firm.taxbanditsDisclosureAckAt,
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
        filingProvider: z.enum(['iris', 'tax1099', 'taxbandits']).optional(),
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
    // TaxBandits config (only when the appliance feature flag is on)
    if (loadEnv().TAXBANDITS_ENABLED) {
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
        isCorrection: z.boolean().default(false),
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
    // Default to the firm's filing backend, falling back to Tax1099 for IRIS firms
    // that still hold a Tax1099 key (either provider offers real-time TIN matching).
    const firm = await db.query.firms.findFirst({ where: eq(firms.id, req.staff!.firmId) });
    const chosen = provider ?? (firm?.filingProvider === 'taxbandits' ? 'taxbandits' : 'tax1099');
    const client =
      chosen === 'taxbandits' ? await buildTaxBanditsClient(db, req.staff!.firmId) : await buildTax1099Client(db, req.staff!.firmId);
    const tin = getCrypto().decrypt(recip.tinEncrypted);
    const result = await client.tinMatch(tin, recip.name1, recip.tinType);
    // reflect a mismatch onto the recipient's W-9 status so staff see it in-grid
    if (!result.match && recip.w9Status !== 'requested') {
      await db.update(recipients).set({ w9Status: 'stale', updatedAt: new Date() }).where(eq(recipients.id, recip.id));
    }
    // persist a provider-tagged, staleness-aware result
    await db
      .update(tinMatchResults)
      .set({ stale: true })
      .where(and(eq(tinMatchResults.recipientId, recip.id), eq(tinMatchResults.stale, false)));
    await db.insert(tinMatchResults).values({
      firmId: req.staff!.firmId,
      recipientId: recip.id,
      provider: chosen === 'taxbandits' ? 'taxbandits' : 'irs',
      status: result.match ? 'match' : 'mismatch',
      code: result.code,
      message: result.message,
    });
    res.locals['audit'] = { action: `${chosen}.tin-match`, entityType: 'recipient', entityId: recip.id, detail: { match: result.match } };
    res.json(result);
  }),
);

// --- transmission log -----------------------------------------------------------

irisRouter.get(
  '/transmissions',
  h(async (req, res) => {
    const q = z.object({ taxYear: z.coerce.number().int().optional() }).parse(req.query);
    const conds = [eq(transmissions.firmId, req.staff!.firmId)];
    if (q.taxYear) conds.push(eq(transmissions.taxYear, q.taxYear));
    const rows = await getDb()
      .select()
      .from(transmissions)
      .where(and(...conds))
      .orderBy(desc(transmissions.createdAt));
    res.json({
      transmissions: rows.map((t) => ({
        id: t.id,
        taxYear: t.taxYear,
        environment: t.environment,
        utid: t.utid,
        receiptId: t.receiptId,
        status: t.status,
        isCorrection: t.isCorrection,
        recordCount: t.recordCount,
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
