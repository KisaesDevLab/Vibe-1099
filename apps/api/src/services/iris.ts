/**
 * IRIS transmission service (Phase 9): batch composer (queued records →
 * submissions per payer, size caps), snapshot-on-transmit, UTID idempotency,
 * XML build + pre-checks, and ack application to record level.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { AppError, ErrorCodes, maskTin, type FormType } from '@vibe1099/shared';
import {
  buildTax1099Payload,
  buildTaxBanditsPayload,
  buildTransmissionXml,
  generateUtid,
  getCrypto,
  preSubmitCheck,
  preSubmitCheckTaxBandits,
  preTransmitCheck,
  putBlob,
  type FilingProviderKind,
  type IrisFormRecord,
  type IrisTransmissionInput,
} from '@vibe1099/core';
import { randomUUID } from 'node:crypto';
import { firms, formRecords, getDb, payers, recipients, statesConfig, transmissions, type Db } from '@vibe1099/db';
import { loadTaxBanditsConfig, loadTax1099Config, resolveCorrectionProvider, resolveProviderKind } from './filing.js';

export interface IrisFirmConfig {
  tcc: string;
  apiClientId: string;
  privateJwk: Record<string, unknown>;
  environment: 'ATS' | 'PROD';
}

export async function loadIrisConfig(db: Db, firmId: string): Promise<IrisFirmConfig> {
  const firm = await db.query.firms.findFirst({ where: eq(firms.id, firmId) });
  if (!firm) throw AppError.notFound('Firm');
  if (!firm.irisTcc || !firm.irisApiClientId || !firm.irisJwkEncrypted) {
    throw new AppError(ErrorCodes.E_IRIS_AUTH, 'IRIS is not configured — enter TCC, API Client ID, and JWK in Settings', 409);
  }
  return {
    tcc: firm.irisTcc,
    apiClientId: firm.irisApiClientId,
    privateJwk: JSON.parse(getCrypto().decrypt(firm.irisJwkEncrypted)) as Record<string, unknown>,
    environment: firm.irisEnvironment as 'ATS' | 'PROD',
  };
}

async function cfsfStates(db: Db): Promise<string[]> {
  const rows = await db.select().from(statesConfig).where(eq(statesConfig.participatesCfsf, true));
  return rows.map((r) => r.state);
}

/**
 * Compose a transmission from queued records for one payer + tax year.
 * Snapshot-on-transmit: each record stores an immutable as-filed copy.
 */
export async function composeTransmission(
  db: Db,
  firmId: string,
  payerId: string,
  taxYear: number,
  createdBy: string,
  opts: { isCorrection?: boolean; recordIds?: string[] } = {},
): Promise<{ transmissionId: string; recordCount: number; problems: string[] }> {
  const firm = await db.query.firms.findFirst({ where: eq(firms.id, firmId) });
  const payer = await db.query.payers.findFirst({ where: and(eq(payers.id, payerId), eq(payers.firmId, firmId)) });
  if (!firm || !payer) throw AppError.notFound('Payer');

  // provider selection (per-payer override → firm default). IRIS needs a TCC/JWK;
  // Tax1099/TaxBandits need only the firm's credentials, so the payer never
  // registers with IRS. Corrections override this: they MUST stay on the provider
  // that filed the original (affinity invariant, addendum §2.3).
  let provider: FilingProviderKind = await resolveProviderKind(db, firmId, payerId);
  if (opts.isCorrection && opts.recordIds?.length) {
    const affinity = await resolveCorrectionProvider(db, firmId, opts.recordIds);
    if (affinity) provider = affinity; // corrections follow the original filing's provider
  }
  const irisConfig = provider === 'iris' ? await loadIrisConfig(db, firmId) : null;
  const tax1099Config = provider === 'tax1099' ? await loadTax1099Config(db, firmId) : null;
  const taxbanditsConfig = provider === 'taxbandits' ? await loadTaxBanditsConfig(db, firmId) : null;
  // reuse the environment column: sandbox↔ATS, production↔PROD (provider disambiguates)
  const environment: 'ATS' | 'PROD' =
    provider === 'iris'
      ? irisConfig!.environment
      : provider === 'tax1099'
        ? tax1099Config!.environment === 'production'
          ? 'PROD'
          : 'ATS'
        : taxbanditsConfig!.environment === 'production'
          ? 'PROD'
          : 'ATS';
  const tcc = irisConfig?.tcc ?? '';

  const conds = [
    eq(formRecords.firmId, firmId),
    eq(formRecords.payerId, payerId),
    eq(formRecords.taxYear, taxYear),
    eq(formRecords.status, 'queued'),
  ];
  if (opts.recordIds?.length) conds.push(inArray(formRecords.id, opts.recordIds));
  const records = await db
    .select()
    .from(formRecords)
    .where(and(...conds));
  if (!records.length) throw AppError.validation('No queued records for this payer/year');

  // duplicate-submission guard: no record may already belong to an in-flight transmission
  const inFlight = records.filter((r) => r.transmissionId != null);
  if (inFlight.length) {
    throw AppError.conflict(`${inFlight.length} record(s) already belong to a transmission — resolve those first`);
  }

  // Type-2 corrections are a linked pair (zeroing record + new original) that IRS
  // requires be transmitted together. Refuse to compose a batch that splits a pair.
  const idSet = new Set(records.map((r) => r.id));
  for (const r of records) {
    if (r.correctionType === 'two_transaction_new' && (!r.correctsId || !idSet.has(r.correctsId))) {
      throw AppError.validation('A Type 2 correction must transmit with its paired zeroing record — queue both together.');
    }
    if (r.correctionType === 'two_transaction_zero' && !records.some((o) => o.correctsId === r.id && o.correctionType === 'two_transaction_new')) {
      throw AppError.validation('A Type 2 zeroing record must transmit with its paired new record — queue both together.');
    }
  }

  const crypto = getCrypto();
  // scope recipient decryption to the firm — never decrypt/transmit a foreign
  // firm's TIN even if a record's recipientId was poisoned by an upstream write
  const recipientRows = await db
    .select()
    .from(recipients)
    .where(and(eq(recipients.firmId, firmId), inArray(recipients.id, [...new Set(records.map((r) => r.recipientId))])));
  const rmap = new Map(recipientRows.map((r) => [r.id, r]));
  for (const r of records) {
    if (!rmap.has(r.recipientId)) {
      throw AppError.validation(`Record ${r.id} references a recipient outside this firm`);
    }
  }

  const irisRecords: IrisFormRecord[] = records.map((r) => {
    const recip = rmap.get(r.recipientId);
    if (!recip) throw AppError.notFound(`Recipient for record ${r.id}`);
    return {
      recordId: r.id,
      formType: r.formType as FormType,
      taxYear: r.taxYear,
      recipient: {
        tin: crypto.decrypt(recip.tinEncrypted),
        tinType: recip.tinType,
        name1: recip.name1,
        name2: recip.name2 || undefined,
        address: {
          line1: recip.address['line1'] ?? '',
          line2: recip.address['line2'] || undefined,
          city: recip.address['city'] ?? '',
          state: recip.address['state'] ?? '',
          zip: recip.address['zip'] ?? '',
        },
      },
      boxValues: r.boxValues,
      accountNumber: r.accountNumber || undefined,
      secondTinNotice: r.secondTinNotice,
      corrected: r.correctionType != null,
      correctionKind: r.correctionType ?? undefined,
      originalRecordId: r.correctsId ?? undefined,
    };
  });

  // idempotency id: IRIS uses the Pub 5718 UTID; Tax1099 gets a stable submission ref
  const utid = provider === 'iris' ? generateUtid(tcc, environment) : `T99-${randomUUID()}`;
  const payerTin = crypto.decrypt(payer.tinEncrypted);
  const input: IrisTransmissionInput = {
    utid,
    tcc,
    taxYear,
    environment,
    transmitter: {
      tcc,
      tin: firm.ein.replace(/\D/g, ''),
      tinType: 'EIN',
      name1: firm.name,
      address: {
        line1: firm.address['line1'] ?? '',
        city: firm.address['city'] ?? '',
        state: firm.address['state'] ?? '',
        zip: firm.address['zip'] ?? '',
      },
      phone: firm.phone || undefined,
    },
    issuer: {
      tin: payerTin,
      tinType: payer.tinType,
      name1: payer.legalName,
      name2: payer.dbaName || undefined,
      address: {
        line1: payer.address['line1'] ?? '',
        line2: payer.address['line2'] || undefined,
        city: payer.address['city'] ?? '',
        state: payer.address['state'] ?? '',
        zip: payer.address['zip'] ?? '',
      },
      phone: payer.phone || undefined,
    },
    records: irisRecords,
    cfsfStates: await cfsfStates(db),
    isCorrection: !!opts.isCorrection,
  };

  // Build the provider payload + run its pre-checks, then stash it in a blob the
  // worker will send. IRIS → XML (Pub 5718); Tax1099/TaxBandits → JSON form model.
  let xmlBlobId: string;
  if (provider === 'iris') {
    const problems = preTransmitCheck(input);
    if (problems.length) throw AppError.validation('Pre-transmit checks failed', problems);
    const xml = buildTransmissionXml(input);
    xmlBlobId = await putBlob(db, {
      firmId,
      kind: 'iris_xml',
      contentType: 'application/xml',
      filename: `${utid}.xml`,
      bytes: Buffer.from(xml, 'utf8'),
      encrypt: true,
    });
  } else if (provider === 'taxbandits') {
    const payload = buildTaxBanditsPayload(input, taxbanditsConfig!.environment, {
      postalMailing: taxbanditsConfig!.postalMailing,
      onlineAccess: taxbanditsConfig!.onlineAccess,
    });
    const problems = preSubmitCheckTaxBandits(payload);
    if (problems.length) throw AppError.validation('Pre-submit checks failed', problems);
    xmlBlobId = await putBlob(db, {
      firmId,
      kind: 'tax1099_payload', // shared JSON-payload blob kind (encrypted at rest)
      contentType: 'application/json',
      filename: `${utid}.json`,
      bytes: Buffer.from(JSON.stringify(payload), 'utf8'),
      encrypt: true,
    });
  } else {
    const payload = buildTax1099Payload(input, tax1099Config!.environment);
    const problems = preSubmitCheck(payload);
    if (problems.length) throw AppError.validation('Pre-submit checks failed', problems);
    xmlBlobId = await putBlob(db, {
      firmId,
      kind: 'tax1099_payload',
      contentType: 'application/json',
      filename: `${utid}.json`,
      bytes: Buffer.from(JSON.stringify(payload), 'utf8'),
      encrypt: true,
    });
  }

  // CLAIM the records atomically to prevent a double-file race (concurrent
  // transmit-all + single transmit, or a double-click). An advisory xact lock
  // serializes composes for this (firm, payer, year); the FOR UPDATE re-read
  // rejects records already claimed by a transmission that landed first.
  const recordIds = records.map((r) => r.id);
  const txId = await db.transaction(async (dbx) => {
    await dbx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${firmId}:${payerId}:${taxYear}`}, 0))`);
    const locked = await dbx
      .select({ id: formRecords.id, transmissionId: formRecords.transmissionId, status: formRecords.status })
      .from(formRecords)
      .where(inArray(formRecords.id, recordIds))
      .for('update');
    const claimed = locked.filter((r) => r.transmissionId != null || r.status !== 'queued');
    if (claimed.length) {
      throw AppError.conflict(`${claimed.length} record(s) were already transmitted by a concurrent run — re-check the transmission log`);
    }
    const [tx] = await dbx
      .insert(transmissions)
      .values({
        firmId,
        taxYear,
        provider,
        environment,
        utid,
        status: 'building',
        isCorrection: !!opts.isCorrection,
        recordCount: records.length,
        xmlBlobId,
        cfsfStates: input.cfsfStates,
        createdBy,
      })
      .returning({ id: transmissions.id });
    if (!tx) throw new Error('transmission insert failed');
    // snapshot-on-transmit + link records
    for (const r of records) {
      await dbx
        .update(formRecords)
        .set({
          transmissionId: tx.id,
          filedSnapshot: {
            boxValues: r.boxValues,
            accountNumber: r.accountNumber,
            recipientId: r.recipientId,
            recipientName: rmap.get(r.recipientId)?.name1,
            recipientTinMasked: maskTin(rmap.get(r.recipientId)?.tinLast4 ?? '', rmap.get(r.recipientId)?.tinType ?? 'SSN'),
            // payer identity as filed — needed to diff payer-name/TIN corrections
            // and to preserve who the return named even if the payer is later edited
            payerId: payer.id,
            payerName: payer.legalName,
            payerTinMasked: maskTin(payer.tinLast4 ?? '', payer.tinType),
            taxYear: r.taxYear,
            formType: r.formType,
            snapshotAt: new Date().toISOString(),
            utid,
          },
          updatedAt: new Date(),
        })
        .where(eq(formRecords.id, r.id));
    }
    return tx.id;
  });

  return { transmissionId: txId, recordCount: records.length, problems: [] };
}

// applyAckToRecords lives in @vibe1099/core (shared with the worker).
