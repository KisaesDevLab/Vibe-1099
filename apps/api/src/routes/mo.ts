/**
 * Missouri direct file routes (Phase 10): preview → generate .txt → download →
 * manual status tracking (uploaded/accepted/rejected), whole-file rejection
 * regenerate flow, state config table.
 */
import { Router } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, formatCents, sumCents, zTaxYear, type FormType } from '@vibe1099/shared';
import {
  boxValuesToAmountCodes,
  buildMo1220File,
  getBlob,
  getCrypto,
  meetsMoThreshold,
  putBlob,
  type Mo1220PayerGroup,
} from '@vibe1099/core';
import { firms, formRecords, getDb, payers, recipients, stateFiles, statesConfig, type Db } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { requireStaff } from '../middleware/auth.js';

export const moRouter = Router();
moRouter.use(requireStaff());

interface MoCandidate {
  record: typeof formRecords.$inferSelect;
  recipient: typeof recipients.$inferSelect;
  amounts: Record<string, number>;
  stateTaxWithheldCents: number;
  includable: boolean;
  reason?: string;
}

async function collectMoCandidates(
  db: Db,
  firmId: string,
  taxYear: number,
  payerIds: string[],
  includeBelowThreshold: boolean,
): Promise<Map<string, MoCandidate[]>> {
  const config = await db.query.statesConfig.findFirst({ where: eq(statesConfig.state, 'MO') });
  const thresholdCents = config?.thresholdCents ?? 120000;

  const rows = await db
    .select({ record: formRecords, recipient: recipients })
    .from(formRecords)
    .innerJoin(recipients, eq(recipients.id, formRecords.recipientId))
    .where(
      and(
        eq(formRecords.firmId, firmId),
        eq(formRecords.taxYear, taxYear),
        inArray(formRecords.payerId, payerIds),
        eq(formRecords.moSource, true),
        inArray(formRecords.status, ['accepted', 'accepted_with_errors', 'transmitted']),
      ),
    );

  const byPayer = new Map<string, MoCandidate[]>();
  for (const { record, recipient } of rows) {
    const { amounts, stateTaxWithheldCents } = boxValuesToAmountCodes(
      record.formType as FormType,
      taxYear,
      record.boxValues,
    );
    const meets = meetsMoThreshold(amounts, stateTaxWithheldCents, thresholdCents);
    const includable = meets || includeBelowThreshold;
    const list = byPayer.get(record.payerId) ?? [];
    list.push({
      record,
      recipient,
      amounts,
      stateTaxWithheldCents,
      includable,
      reason: meets ? undefined : `below $${(thresholdCents / 100).toFixed(0)} MO threshold`,
    });
    byPayer.set(record.payerId, list);
  }
  return byPayer;
}

/** Preview counts/totals before generating. */
moRouter.post(
  '/preview',
  h(async (req, res) => {
    const input = z
      .object({ taxYear: zTaxYear, payerIds: z.array(z.string().uuid()).min(1), includeBelowThreshold: z.boolean().default(false) })
      .parse(req.body);
    const db = getDb();
    const byPayer = await collectMoCandidates(db, req.staff!.firmId, input.taxYear, input.payerIds, input.includeBelowThreshold);
    const preview: Array<Record<string, unknown>> = [];
    for (const [payerId, candidates] of byPayer) {
      const payer = await db.query.payers.findFirst({ where: eq(payers.id, payerId) });
      const included = candidates.filter((c) => c.includable);
      preview.push({
        payerId,
        payerName: payer?.legalName,
        moWithholdingId: payer?.moWithholdingId ?? null,
        included: included.length,
        excluded: candidates.length - included.length,
        totalPayments: formatCents(sumCents(included.flatMap((c) => Object.values(c.amounts)))),
        totalWithheld: formatCents(sumCents(included.map((c) => c.stateTaxWithheldCents))),
        missingWithholdingId: !payer?.moWithholdingId && included.some((c) => c.stateTaxWithheldCents > 0),
      });
    }
    res.json({ preview });
  }),
);

/** Generate the Pub 1220 .txt file. */
moRouter.post(
  '/generate',
  h(async (req, res) => {
    const input = z
      .object({
        taxYear: zTaxYear,
        payerIds: z.array(z.string().uuid()).min(1),
        includeBelowThreshold: z.boolean().default(false),
        testFile: z.boolean().default(false),
      })
      .parse(req.body);
    const db = getDb();
    const firmId = req.staff!.firmId;
    const firm = await db.query.firms.findFirst({ where: eq(firms.id, firmId) });
    if (!firm) throw AppError.notFound('Firm');

    const byPayer = await collectMoCandidates(db, firmId, input.taxYear, input.payerIds, input.includeBelowThreshold);
    if (![...byPayer.values()].some((c) => c.some((x) => x.includable))) {
      throw AppError.validation('No MO-source records match — check the MO-source flag and record statuses');
    }

    const crypto = getCrypto();
    const groups: Mo1220PayerGroup[] = [];
    const includedRecordIds: string[] = [];

    for (const [payerId, candidates] of byPayer) {
      const payer = await db.query.payers.findFirst({ where: eq(payers.id, payerId) });
      if (!payer) continue;
      const byType = new Map<string, MoCandidate[]>();
      for (const c of candidates.filter((x) => x.includable)) {
        const list = byType.get(c.record.formType) ?? [];
        list.push(c);
        byType.set(c.record.formType, list);
      }
      for (const [formType, list] of byType) {
        groups.push({
          payer: {
            tin: crypto.decrypt(payer.tinEncrypted),
            tinType: payer.tinType,
            name: payer.legalName,
            address: payer.address['line1'] ?? '',
            city: payer.address['city'] ?? '',
            state: payer.address['state'] ?? '',
            zip: payer.address['zip'] ?? '',
            phone: payer.phone,
            moWithholdingId: payer.moWithholdingId,
          },
          formType: formType as FormType,
          payees: list.map((c) => ({
            recordId: c.record.id,
            tin: crypto.decrypt(c.recipient.tinEncrypted),
            tinType: c.recipient.tinType,
            name1: c.recipient.name1,
            name2: c.recipient.name2,
            address: c.recipient.address['line1'] ?? '',
            city: c.recipient.address['city'] ?? '',
            state: c.recipient.address['state'] ?? '',
            zip: c.recipient.address['zip'] ?? '',
            accountNumber: c.record.accountNumber,
            amounts: c.amounts,
            stateTaxWithheldCents: c.stateTaxWithheldCents,
            corrected: c.record.correctionType
              ? c.record.correctionType === 'two_transaction_zero' || c.record.correctionType === 'void'
                ? 'G'
                : 'C'
              : null,
          })),
        });
        includedRecordIds.push(...list.map((c) => c.record.id));
      }
    }

    const output = buildMo1220File({
      taxYear: input.taxYear,
      priorYear: input.taxYear < new Date().getFullYear() - 1,
      transmitter: {
        tin: firm.ein,
        name: firm.name,
        companyName: firm.name,
        address: firm.address['line1'] ?? '',
        city: firm.address['city'] ?? '',
        state: firm.address['state'] ?? '',
        zip: firm.address['zip'] ?? '',
        contactName: req.staff!.name,
        contactPhone: firm.phone,
        contactEmail: req.staff!.email,
      },
      groups,
      testFile: input.testFile,
    });

    // uppercase ASCII .txt per MO handbook
    const fileBlobId = await putBlob(db, {
      firmId,
      kind: 'mo_txt',
      contentType: 'text/plain',
      filename: output.filename,
      bytes: Buffer.from(output.content, 'ascii'),
    });

    const [created] = await db
      .insert(stateFiles)
      .values({
        firmId,
        state: 'MO',
        taxYear: input.taxYear,
        payerIds: input.payerIds,
        recordCount: output.payeeCount,
        kRecordTotals: output.kTotals,
        fileBlobId,
        filename: output.filename,
        status: 'generated',
        formRecordIds: includedRecordIds,
        createdBy: req.staff!.userId,
      })
      .returning({ id: stateFiles.id });

    res.locals['audit'] = { action: 'mo.generate', entityType: 'state_file', entityId: created?.id, detail: { records: output.payeeCount } };
    res.status(201).json({
      id: created?.id,
      filename: output.filename,
      recordCounts: output.recordCounts,
      payeeCount: output.payeeCount,
    });
  }),
);

moRouter.get(
  '/files',
  h(async (req, res) => {
    const rows = await getDb()
      .select()
      .from(stateFiles)
      .where(eq(stateFiles.firmId, req.staff!.firmId))
      .orderBy(desc(stateFiles.createdAt));
    res.json({ files: rows });
  }),
);

moRouter.get(
  '/files/:id/download',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const db = getDb();
    const file = await db.query.stateFiles.findFirst({ where: and(eq(stateFiles.id, id), eq(stateFiles.firmId, req.staff!.firmId)) });
    if (!file?.fileBlobId) throw AppError.notFound('State file');
    const blob = await getBlob(db, file.fileBlobId);
    if (!blob) throw AppError.notFound('File blob');
    res.setHeader('content-disposition', `attachment; filename="${file.filename}"`);
    res.type('text/plain').send(blob.bytes);
  }),
);

/** Manual status tracking: generated → uploaded → accepted/rejected (with notes). */
moRouter.post(
  '/files/:id/status',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const { status, notes } = z
      .object({ status: z.enum(['uploaded', 'accepted', 'rejected']), notes: z.string().max(2000).default('') })
      .parse(req.body);
    const db = getDb();
    const file = await db.query.stateFiles.findFirst({ where: and(eq(stateFiles.id, id), eq(stateFiles.firmId, req.staff!.firmId)) });
    if (!file) throw AppError.notFound('State file');

    const allowed: Record<string, string[]> = { generated: ['uploaded'], uploaded: ['accepted', 'rejected'], rejected: [], accepted: [], superseded: [] };
    if (!allowed[file.status]?.includes(status)) {
      throw AppError.state(`Cannot move MO file from ${file.status} to ${status}`);
    }
    await db.update(stateFiles).set({ status, statusNotes: notes, updatedAt: new Date() }).where(eq(stateFiles.id, id));
    res.locals['audit'] = { action: `mo.status.${status}`, entityType: 'state_file', entityId: id };
    res.json({
      ok: true,
      // whole-file rejection guidance (MO rejects entire file)
      guidance:
        status === 'rejected'
          ? 'Missouri rejects the ENTIRE file. Fix the underlying records, then regenerate — the old file will be marked superseded.'
          : undefined,
    });
  }),
);

/** Regenerate after rejection: marks the rejected file superseded, then client calls /generate again. */
moRouter.post(
  '/files/:id/supersede',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    await getDb()
      .update(stateFiles)
      .set({ status: 'superseded', updatedAt: new Date() })
      .where(and(eq(stateFiles.id, id), eq(stateFiles.firmId, req.staff!.firmId)));
    res.locals['audit'] = { action: 'mo.supersede', entityType: 'state_file', entityId: id };
    res.json({ ok: true });
  }),
);

/** MO correction constraints — surfaced in-app (Phase 10 + 11 integration). */
moRouter.get(
  '/correction-guidance',
  h(async (_req, res) => {
    res.json({
      withholding:
        'Withholding-amount errors: file an amended MO-941 and correct on paper (out-of-band checklist) — a corrected 1099 file alone does NOT fix MO withholding.',
      nonWithholding:
        'Non-withholding errors: contact MO DOR to request deletion of the previously submitted file, then resubmit a full corrected file.',
      portal: 'https://mytax.mo.gov — Online W-2/1099 Submission System (MOID + PIN required)',
    });
  }),
);

/** State config table (stub — MO live, schema ready for expansion). */
moRouter.get(
  '/states',
  h(async (_req, res) => {
    const rows = await getDb().select().from(statesConfig).orderBy(statesConfig.state);
    res.json({ states: rows });
  }),
);
