/**
 * Dashboard & reporting (Phase 12): season progress, payer detail with delivery
 * matrix, exception queue (one worklist), filing summary PDF, year-end close.
 */
import { Router } from 'express';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, deadlinesFor, formatCents, getFormDef, maskTin, zTaxYear, type FormType } from '@vibe1099/shared';
import { getRenderClient } from '@vibe1099/core';
import { deliveries, firms, formRecords, getDb, payers, recipients, transmissions, yearLocks } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { requireStaff } from '../middleware/auth.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireStaff());

/** Firm dashboard: season progress by payer + deadline countdowns. */
dashboardRouter.get(
  '/season/:taxYear',
  h(async (req, res) => {
    const taxYear = zTaxYear.parse(Number(req.params['taxYear']));
    const db = getDb();
    const firmId = req.staff!.firmId;

    const progress = await db
      .select({
        payerId: formRecords.payerId,
        payerName: payers.legalName,
        total: sql<number>`count(*)::int`,
        entered: sql<number>`count(*) FILTER (WHERE ${formRecords.status} = 'draft')::int`,
        ready: sql<number>`count(*) FILTER (WHERE ${formRecords.status} IN ('ready','queued'))::int`,
        transmitted: sql<number>`count(*) FILTER (WHERE ${formRecords.status} = 'transmitted')::int`,
        accepted: sql<number>`count(*) FILTER (WHERE ${formRecords.status} IN ('accepted','accepted_with_errors'))::int`,
        rejected: sql<number>`count(*) FILTER (WHERE ${formRecords.status} = 'rejected')::int`,
        delivered: sql<number>`(SELECT count(DISTINCT d.form_record_id) FROM deliveries d
          JOIN form_records fr2 ON fr2.id = d.form_record_id
          WHERE fr2.payer_id = ${formRecords.payerId} AND fr2.tax_year = ${taxYear} AND d.sent_at IS NOT NULL)::int`,
      })
      .from(formRecords)
      .innerJoin(payers, eq(payers.id, formRecords.payerId))
      .where(and(eq(formRecords.firmId, firmId), eq(formRecords.taxYear, taxYear), sql`${formRecords.status} != 'corrected'`))
      .groupBy(formRecords.payerId, payers.legalName)
      .orderBy(payers.legalName);

    const lock = await db.query.yearLocks.findFirst({ where: and(eq(yearLocks.firmId, firmId), eq(yearLocks.taxYear, taxYear)) });

    res.json({ taxYear, deadlines: deadlinesFor(taxYear), progress, yearLocked: !!lock });
  }),
);

/** Payer detail: counts + dollar totals by type, delivery status matrix. */
dashboardRouter.get(
  '/payer/:payerId/:taxYear',
  h(async (req, res) => {
    const payerId = z.string().uuid().parse(req.params['payerId']);
    const taxYear = zTaxYear.parse(Number(req.params['taxYear']));
    const db = getDb();
    const firmId = req.staff!.firmId;

    const forms = await db
      .select()
      .from(formRecords)
      .where(
        and(
          eq(formRecords.firmId, firmId),
          eq(formRecords.payerId, payerId),
          eq(formRecords.taxYear, taxYear),
          sql`${formRecords.status} != 'corrected'`,
        ),
      );
    const formIds = forms.map((f) => f.id);
    const dels = formIds.length
      ? await db.select().from(deliveries).where(inArray(deliveries.formRecordId, formIds))
      : [];

    const matrix = {
      paper: dels.filter((d) => d.channel === 'paper' && d.sentAt).length,
      email: dels.filter((d) => d.channel === 'email' && d.sentAt).length,
      sms: dels.filter((d) => d.channel === 'sms' && d.sentAt).length,
      viewed: dels.filter((d) => d.viewedAt).length,
      downloaded: dels.filter((d) => d.downloadedAt).length,
      bounced: dels.filter((d) => d.bouncedAt).length,
    };

    const byType: Record<string, { count: number; totalCents: number }> = {};
    for (const f of forms) {
      const bucket = (byType[f.formType] ??= { count: 0, totalCents: 0 });
      bucket.count++;
      const def = getFormDef(f.formType as FormType, taxYear);
      for (const box of def.boxes) {
        if (box.kind !== 'cents' || box.stateField) continue;
        const v = f.boxValues[box.id];
        if (typeof v === 'number') bucket.totalCents += v;
      }
    }

    res.json({
      byType: Object.entries(byType).map(([formType, b]) => ({ formType, count: b.count, total: formatCents(b.totalCents) })),
      deliveryMatrix: matrix,
    });
  }),
);

/**
 * Consolidated per-payer filing status: one row per payer with the filing
 * date/receipt/status and the list of rejected 1099s (with reasons). Joins forms
 * to their transmission (the transmissions table has no payer_id — the link is
 * through the form records).
 */
dashboardRouter.get(
  '/filing-status/:taxYear',
  h(async (req, res) => {
    const taxYear = zTaxYear.parse(Number(req.params['taxYear']));
    const db = getDb();
    const firmId = req.staff!.firmId;

    const rows = await db
      .select({
        payerId: formRecords.payerId,
        payerName: payers.legalName,
        clientId: payers.clientId,
        status: formRecords.status,
        formType: formRecords.formType,
        recordErrors: formRecords.recordErrors,
        recipientName: recipients.name1,
        receiptId: transmissions.receiptId,
        transmittedAt: transmissions.transmittedAt,
        txStatus: transmissions.status,
        environment: transmissions.environment,
      })
      .from(formRecords)
      .innerJoin(payers, eq(payers.id, formRecords.payerId))
      .innerJoin(recipients, eq(recipients.id, formRecords.recipientId))
      .leftJoin(transmissions, eq(transmissions.id, formRecords.transmissionId))
      .where(and(eq(formRecords.firmId, firmId), eq(formRecords.taxYear, taxYear), sql`${formRecords.status} != 'corrected'`))
      .orderBy(payers.legalName);

    type Agg = {
      payerId: string;
      payerName: string;
      clientId: string | null;
      counts: Record<string, number>;
      total: number;
      lastFiledAt: Date | null;
      receiptId: string | null;
      environment: string | null;
      rejects: Array<{ recipientName: string; formType: string; reasons: string[] }>;
    };
    const byPayer = new Map<string, Agg>();
    for (const r of rows) {
      let a = byPayer.get(r.payerId);
      if (!a) {
        a = { payerId: r.payerId, payerName: r.payerName, clientId: r.clientId, counts: {}, total: 0, lastFiledAt: null, receiptId: null, environment: null, rejects: [] };
        byPayer.set(r.payerId, a);
      }
      a.total += 1;
      a.counts[r.status] = (a.counts[r.status] ?? 0) + 1;
      if (r.transmittedAt && (!a.lastFiledAt || r.transmittedAt > a.lastFiledAt)) {
        a.lastFiledAt = r.transmittedAt;
        a.receiptId = r.receiptId;
        a.environment = r.environment;
      }
      if (r.status === 'rejected') {
        const reasons = (r.recordErrors ?? []).map((e) => e.translated ?? e.message).filter(Boolean);
        a.rejects.push({ recipientName: r.recipientName, formType: r.formType, reasons: reasons.length ? reasons : ['rejected by IRS'] });
      }
    }

    // derive a single overall status label per payer
    const overall = (a: Agg): string => {
      const c = a.counts;
      const accepted = (c['accepted'] ?? 0) + (c['accepted_with_errors'] ?? 0);
      if (c['rejected']) return accepted ? 'partially rejected' : 'rejected';
      if (accepted === a.total) return 'accepted';
      if (c['transmitted']) return 'transmitted (awaiting ack)';
      if (c['queued']) return 'queued';
      if (c['ready']) return 'ready to file';
      if (accepted) return 'partially accepted';
      return 'not filed';
    };

    const filingStatus = [...byPayer.values()].map((a) => ({
      payerId: a.payerId,
      payerName: a.payerName,
      clientId: a.clientId,
      total: a.total,
      status: overall(a),
      counts: a.counts,
      filedAt: a.lastFiledAt ? a.lastFiledAt.toISOString().slice(0, 10) : null,
      receiptId: a.receiptId,
      environment: a.environment,
      rejectCount: a.rejects.length,
      rejects: a.rejects,
    }));

    res.json({ taxYear, payers: filingStatus });
  }),
);

/** Exception queue — one worklist: rejects, TIN failures, missing addresses, missing W-9s. */
dashboardRouter.get(
  '/exceptions/:taxYear',
  h(async (req, res) => {
    const taxYear = zTaxYear.parse(Number(req.params['taxYear']));
    const db = getDb();
    const firmId = req.staff!.firmId;

    const rejected = await db
      .select({ f: formRecords, recipientName: recipients.name1 })
      .from(formRecords)
      .innerJoin(recipients, eq(recipients.id, formRecords.recipientId))
      .where(and(eq(formRecords.firmId, firmId), eq(formRecords.taxYear, taxYear), eq(formRecords.status, 'rejected')));

    const activeRecipientIds = db
      .selectDistinct({ rid: formRecords.recipientId })
      .from(formRecords)
      .where(and(eq(formRecords.firmId, firmId), eq(formRecords.taxYear, taxYear)));

    const missingAddress = await db
      .select({ id: recipients.id, name1: recipients.name1 })
      .from(recipients)
      .where(
        and(
          eq(recipients.firmId, firmId),
          isNull(recipients.mergedIntoId),
          sql`${recipients.id} IN ${activeRecipientIds}`,
          sql`((${recipients.address}->>'line1') IS NULL OR (${recipients.address}->>'line1') = '' OR (${recipients.address}->>'zip') IS NULL OR (${recipients.address}->>'zip') = '')`,
        ),
      );

    const missingW9 = await db
      .select({ id: recipients.id, name1: recipients.name1, w9Status: recipients.w9Status })
      .from(recipients)
      .where(
        and(
          eq(recipients.firmId, firmId),
          isNull(recipients.mergedIntoId),
          sql`${recipients.id} IN ${activeRecipientIds}`,
          inArray(recipients.w9Status, ['none', 'stale']),
        ),
      );

    res.json({
      exceptions: [
        ...rejected.map(({ f, recipientName }) => ({
          kind: 'rejected' as const,
          formRecordId: f.id,
          recipientName,
          formType: f.formType,
          detail: (f.recordErrors ?? []).map((e) => e.translated ?? e.message).join('; ') || 'Rejected by IRS',
        })),
        ...missingAddress.map((r) => ({ kind: 'missing_address' as const, recipientId: r.id, recipientName: r.name1, detail: 'Recipient address incomplete' })),
        ...missingW9.map((r) => ({ kind: 'missing_w9' as const, recipientId: r.id, recipientName: r.name1, detail: r.w9Status === 'stale' ? 'W-9 on file is stale' : 'No W-9 on file' })),
      ],
    });
  }),
);

/** Filing summary report PDF (per payer, via sidecar). */
dashboardRouter.get(
  '/report/:payerId/:taxYear',
  h(async (req, res) => {
    const payerId = z.string().uuid().parse(req.params['payerId']);
    const taxYear = zTaxYear.parse(Number(req.params['taxYear']));
    const db = getDb();
    const firmId = req.staff!.firmId;
    const payer = await db.query.payers.findFirst({ where: and(eq(payers.id, payerId), eq(payers.firmId, firmId)) });
    if (!payer) throw AppError.notFound('Payer');
    const firm = await db.query.firms.findFirst({ where: eq(firms.id, firmId) });

    const forms = await db
      .select()
      .from(formRecords)
      .where(
        and(
          eq(formRecords.firmId, firmId),
          eq(formRecords.payerId, payerId),
          eq(formRecords.taxYear, taxYear),
          sql`${formRecords.status} != 'corrected'`,
        ),
      );
    const formIds = forms.map((f) => f.id);
    const dels = formIds.length ? await db.select().from(deliveries).where(inArray(deliveries.formRecordId, formIds)) : [];
    const txIds = [...new Set(forms.map((f) => f.transmissionId).filter((x): x is string => !!x))];
    const txs = txIds.length ? await db.select().from(transmissions).where(inArray(transmissions.id, txIds)) : [];

    const sections = Object.entries(
      forms.reduce<Record<string, Array<typeof formRecords.$inferSelect>>>((acc, f) => {
        (acc[f.formType] ??= []).push(f);
        return acc;
      }, {}),
    ).map(([formType, list]) => {
      const def = getFormDef(formType as FormType, taxYear);
      const totals: Array<{ label: string; value: string }> = [];
      for (const box of def.boxes) {
        if (box.kind !== 'cents') continue;
        const total = list.reduce((n, f) => n + (typeof f.boxValues[box.id] === 'number' ? (f.boxValues[box.id] as number) : 0), 0);
        if (total > 0) totals.push({ label: `Box ${box.boxNumber} — ${box.label}`, value: formatCents(total) });
      }
      return { form_type: formType, count: list.length, totals };
    });

    const pdf = await getRenderClient().render({
      template: 'report_summary.html',
      data: {
        firm_name: firm?.name ?? '',
        payer: { name: payer.legalName, tin_display: maskTin(payer.tinLast4, payer.tinType) },
        tax_year: taxYear,
        generated_at: new Date().toISOString().slice(0, 10),
        sections,
        deliveries: {
          paper: dels.filter((d) => d.channel === 'paper' && d.sentAt).length,
          email: dels.filter((d) => d.channel === 'email' && d.sentAt).length,
          sms: dels.filter((d) => d.channel === 'sms' && d.sentAt).length,
          viewed: dels.filter((d) => d.viewedAt).length,
        },
        transmissions: txs.map((t) => ({ receipt_id: t.receiptId ?? t.utid, status: t.status, at: t.transmittedAt?.toISOString().slice(0, 10) ?? '' })),
      },
    });
    res.setHeader('content-disposition', `attachment; filename="filing-summary-${taxYear}.pdf"`);
    res.type('application/pdf').send(pdf);
  }),
);

/** Year-end close: lock tax year (read-only except corrections). */
dashboardRouter.post(
  '/year-lock/:taxYear',
  requireStaff('admin'),
  h(async (req, res) => {
    const taxYear = zTaxYear.parse(Number(req.params['taxYear']));
    await getDb()
      .insert(yearLocks)
      .values({ firmId: req.staff!.firmId, taxYear, lockedBy: req.staff!.userId })
      .onConflictDoNothing();
    res.locals['audit'] = { action: 'year.lock', entityType: 'year_lock', entityId: String(taxYear) };
    res.json({ ok: true });
  }),
);

dashboardRouter.delete(
  '/year-lock/:taxYear',
  requireStaff('admin'),
  h(async (req, res) => {
    const taxYear = zTaxYear.parse(Number(req.params['taxYear']));
    await getDb()
      .delete(yearLocks)
      .where(and(eq(yearLocks.firmId, req.staff!.firmId), eq(yearLocks.taxYear, taxYear)));
    res.locals['audit'] = { action: 'year.unlock', entityType: 'year_lock', entityId: String(taxYear) };
    res.json({ ok: true });
  }),
);
