/**
 * IRIS transmission service (Phase 9): batch composer (queued records →
 * submissions per payer, size caps), snapshot-on-transmit, UTID idempotency,
 * XML build + pre-checks, and ack application to record level.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { AppError, ErrorCodes, maskTin, type FormType } from '@vibe1099/shared';
import {
  buildTransmissionXml,
  generateUtid,
  getCrypto,
  preTransmitCheck,
  putBlob,
  type IrisFormRecord,
  type IrisTransmissionInput,
} from '@vibe1099/core';
import { firms, formRecords, getDb, payers, recipients, statesConfig, transmissions, type Db } from '@vibe1099/db';

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
  const config = await loadIrisConfig(db, firmId);

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

  const crypto = getCrypto();
  const recipientRows = await db
    .select()
    .from(recipients)
    .where(inArray(recipients.id, [...new Set(records.map((r) => r.recipientId))]));
  const rmap = new Map(recipientRows.map((r) => [r.id, r]));

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

  const utid = generateUtid(config.tcc, config.environment);
  const payerTin = crypto.decrypt(payer.tinEncrypted);
  const input: IrisTransmissionInput = {
    utid,
    tcc: config.tcc,
    taxYear,
    environment: config.environment,
    transmitter: {
      tcc: config.tcc,
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

  const problems = preTransmitCheck(input);
  if (problems.length) {
    throw AppError.validation('Pre-transmit checks failed', problems);
  }

  const xml = buildTransmissionXml(input);
  const xmlBlobId = await putBlob(db, {
    firmId,
    kind: 'iris_xml',
    contentType: 'application/xml',
    filename: `${utid}.xml`,
    bytes: Buffer.from(xml, 'utf8'),
  });

  const [tx] = await db
    .insert(transmissions)
    .values({
      firmId,
      taxYear,
      environment: config.environment,
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
    await db
      .update(formRecords)
      .set({
        transmissionId: tx.id,
        filedSnapshot: {
          boxValues: r.boxValues,
          accountNumber: r.accountNumber,
          recipientId: r.recipientId,
          recipientName: rmap.get(r.recipientId)?.name1,
          recipientTinMasked: maskTin(rmap.get(r.recipientId)?.tinLast4 ?? '', rmap.get(r.recipientId)?.tinType ?? 'SSN'),
          taxYear: r.taxYear,
          formType: r.formType,
          snapshotAt: new Date().toISOString(),
          utid,
        },
        updatedAt: new Date(),
      })
      .where(eq(formRecords.id, r.id));
  }

  return { transmissionId: tx.id, recordCount: records.length, problems: [] };
}

// applyAckToRecords lives in @vibe1099/core (shared with the worker).
