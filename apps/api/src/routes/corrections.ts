/**
 * Corrections routes (Phase 11): diff preview, create (reviewer gate config),
 * chain history, outstanding dashboard, MO impact prompt, corrected re-delivery.
 */
import { Router } from 'express';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, zFormType } from '@vibe1099/shared';
import { getQueue, loadEnv, QUEUE_NAMES, type DeliveryJob } from '@vibe1099/core';
import { firms, formRecords, getDb, payers, recipients, stateFiles } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { requireStaff } from '../middleware/auth.js';
import { correctionChain, correctionDiff, createCorrection } from '../services/corrections.js';
import { getSetting } from '../services/settings.js';
import { createPortalDelivery } from './deliveries.js';

export const correctionsRouter = Router();
correctionsRouter.use(requireStaff());

const zCorrectionRequest = z.object({
  originalId: z.string().uuid(),
  reason: z.string().min(3).max(2000),
  boxValues: z.record(z.union([z.number().int(), z.boolean(), z.string(), z.null()])).optional(),
  voidRecord: z.boolean().default(false),
  newRecipientId: z.string().uuid().optional(),
  newFormType: zFormType.optional(),
});

/** Diff-from-snapshot preview before queueing. */
correctionsRouter.post(
  '/diff',
  h(async (req, res) => {
    const input = zCorrectionRequest.parse(req.body);
    const result = await correctionDiff(getDb(), req.staff!.firmId, input);
    res.json(result);
  }),
);

correctionsRouter.post(
  '/',
  h(async (req, res) => {
    const input = zCorrectionRequest.parse(req.body);
    const db = getDb();

    // reviewer approval gate on all corrections (config)
    const gate = (await getSetting<boolean>('reviewer_gate_enabled')) ?? false;
    if (gate && req.staff!.role === 'preparer') {
      throw AppError.forbidden('Corrections require reviewer or admin role while the reviewer gate is enabled');
    }

    const result = await createCorrection(db, req.staff!.firmId, input, req.staff!.userId);

    // MO impact prompt: was the original in a generated MO file?
    const original = await db.query.formRecords.findFirst({ where: eq(formRecords.id, input.originalId) });
    let moImpact: string | null = null;
    if (original?.moSource) {
      const moFiles = await db
        .select({ id: stateFiles.id, status: stateFiles.status })
        .from(stateFiles)
        .where(
          and(
            eq(stateFiles.firmId, req.staff!.firmId),
            eq(stateFiles.taxYear, original.taxYear),
            sql`${stateFiles.formRecordIds} @> ${JSON.stringify([original.id])}::jsonb`,
          ),
        );
      if (moFiles.length) {
        const hadWithholding = typeof original.boxValues['stateTaxWithheld'] === 'number' && (original.boxValues['stateTaxWithheld'] as number) > 0;
        moImpact = hadWithholding
          ? 'This record was in a Missouri file AND carries MO withholding: withholding-amount corrections require an amended MO-941 + paper checklist (see MO → correction guidance).'
          : 'This record was in a Missouri file: request DOR delete of the prior file and resubmit a full corrected file (see MO → correction guidance).';
      }
    }

    res.locals['audit'] = {
      action: 'correction.create',
      entityType: 'form_record',
      entityId: input.originalId,
      detail: { classification: result.classification, createdIds: result.createdIds, reason: input.reason },
    };
    res.status(201).json({ ...result, moImpact });
  }),
);

correctionsRouter.get(
  '/chain/:recordId',
  h(async (req, res) => {
    const recordId = z.string().uuid().parse(req.params['recordId']);
    const chain = await correctionChain(getDb(), req.staff!.firmId, recordId);
    res.json({
      chain: chain.map((r) => ({
        id: r.id,
        status: r.status,
        correctionSeq: r.correctionSeq,
        correctionType: r.correctionType,
        correctionReason: r.correctionReason,
        boxValues: r.boxValues,
        filedSnapshot: r.filedSnapshot,
        createdAt: r.createdAt,
      })),
    });
  }),
);

/** Outstanding corrections queue — with payer + recipient, paginated. */
correctionsRouter.get(
  '/outstanding',
  h(async (req, res) => {
    const q = z
      .object({
        payerId: z.string().uuid().optional(),
        taxYear: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const db = getDb();
    const conds = [
      eq(formRecords.firmId, req.staff!.firmId),
      isNotNull(formRecords.correctionType),
      inArray(formRecords.status, ['draft', 'ready', 'queued', 'transmitted', 'accepted', 'accepted_with_errors', 'rejected']),
    ];
    if (q.payerId) conds.push(eq(formRecords.payerId, q.payerId));
    if (q.taxYear) conds.push(eq(formRecords.taxYear, q.taxYear));
    const [rows, [countRow]] = await Promise.all([
      db
        .select({ f: formRecords, payerName: payers.legalName, recipientName: recipients.name1, recipientTin: recipients.tinLast4 })
        .from(formRecords)
        .innerJoin(payers, eq(payers.id, formRecords.payerId))
        .innerJoin(recipients, eq(recipients.id, formRecords.recipientId))
        .where(and(...conds))
        .orderBy(desc(formRecords.updatedAt))
        .limit(q.limit)
        .offset(q.offset),
      db.select({ n: sql<number>`count(*)::int` }).from(formRecords).where(and(...conds)),
    ]);
    res.json({
      outstanding: rows.map(({ f, payerName, recipientName }) => ({
        id: f.id,
        payerId: f.payerId,
        payerName,
        recipientName,
        taxYear: f.taxYear,
        formType: f.formType,
        correctionType: f.correctionType,
        correctionSeq: f.correctionSeq,
        status: f.status,
      })),
      total: countRow?.n ?? 0,
      limit: q.limit,
      offset: q.offset,
    });
  }),
);

/**
 * Corrected re-delivery: after a correction is accepted — paper reprint queues
 * via batches; this endpoint queues the new portal token + notification.
 */
correctionsRouter.post(
  '/:recordId/redeliver',
  h(async (req, res) => {
    const recordId = z.string().uuid().parse(req.params['recordId']);
    const db = getDb();
    const env = loadEnv();
    const record = await db.query.formRecords.findFirst({
      where: and(eq(formRecords.id, recordId), eq(formRecords.firmId, req.staff!.firmId)),
    });
    if (!record) throw AppError.notFound('Form record');
    if (!record.correctionType) throw AppError.validation('Record is not a correction');
    if (record.status !== 'accepted' && record.status !== 'accepted_with_errors') {
      throw AppError.state('Correction must be accepted before re-delivery');
    }

    const recipient = await db.query.recipients.findFirst({ where: eq(recipients.id, record.recipientId) });
    const payer = await db.query.payers.findFirst({ where: eq(payers.id, record.payerId) });
    const firm = await db.query.firms.findFirst({ where: eq(firms.id, req.staff!.firmId) });
    if (!recipient || !payer) throw AppError.notFound('Parties');

    const channel: 'email' | 'sms' | null = recipient.email
      ? 'email'
      : recipient.mobile && !recipient.smsOptOut
        ? 'sms'
        : null;
    if (!channel) {
      return void res.json({ queued: 0, note: 'Recipient has no electronic contact — corrected paper copy only' });
    }
    const { deliveryId, token, expiresAt } = await createPortalDelivery({
      firmId: req.staff!.firmId,
      formRecordId: record.id,
      channel,
      isCorrected: true,
    });
    const job: DeliveryJob = {
      kind: 'form_notification',
      channel,
      firmId: req.staff!.firmId,
      to: channel === 'email' ? (recipient.email as string) : (recipient.mobile as string),
      templateKey: 'form_corrected',
      vars: {
        taxYear: String(record.taxYear),
        formType: record.formType,
        payerName: payer.legalName,
        firmName: firm?.name ?? '',
        link: `${env.PORTAL_BASE_URL}/f/${encodeURIComponent(token)}`,
        expires: expiresAt.toISOString().slice(0, 10),
      },
      deliveryId,
    };
    await getQueue(QUEUE_NAMES.delivery).add('form_notification', job);
    res.locals['audit'] = { action: 'correction.redeliver', entityType: 'form_record', entityId: recordId };
    res.json({ queued: 1 });
  }),
);
