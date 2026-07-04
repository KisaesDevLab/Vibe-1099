/**
 * Per-payer filing summary report — shared by the dashboard (single) and the
 * bulk summary Filing Run (all payers → one merged PDF).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { AppError, formatCents, getFormDef, maskTin, type FormType } from '@vibe1099/shared';
import { getRenderClient } from '@vibe1099/core';
import { deliveries, firms, formRecords, getDb, payers, transmissions, type Db } from '@vibe1099/db';
import { renderPortalPdf } from './render.js';

export async function buildSummaryData(db: Db, firmId: string, payerId: string, taxYear: number) {
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

  return {
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
    hasForms: forms.length > 0,
  };
}

export async function renderPayerSummary(db: Db, firmId: string, payerId: string, taxYear: number): Promise<Buffer> {
  const data = await buildSummaryData(db, firmId, payerId, taxYear);
  return getRenderClient().render({ template: 'report_summary.html', data });
}

/** Render only if the payer has forms this year — skip blank pages in bulk packets. */
export async function renderPayerSummaryIfAny(
  db: Db,
  firmId: string,
  payerId: string,
  taxYear: number,
): Promise<{ hasForms: boolean; pdf: Buffer | null }> {
  const data = await buildSummaryData(db, firmId, payerId, taxYear);
  if (!data.hasForms) return { hasForms: false, pdf: null };
  const pdf = await getRenderClient().render({ template: 'report_summary.html', data });
  return { hasForms: true, pdf };
}

/** Filename-safe archive name: YYYY_ClientName_Forms1099_ClientID.pdf */
export function archiveFileName(taxYear: number, legalName: string, clientId: string | null): string {
  const name = legalName.replace(/[^A-Za-z0-9]+/g, '') || 'Payer';
  const id = (clientId ?? '').replace(/[^A-Za-z0-9-]+/g, '') || 'NoID';
  return `${taxYear}_${name}_Forms1099_${id}.pdf`;
}

/**
 * Build one payer's 1099 archive: a summary/cover page followed by each of the
 * payer's 1099 forms for the year, merged into a single PDF. Returns the
 * formatted filename. Skips corrected records (the summary already excludes them).
 */
export async function renderPayerArchive(
  db: Db,
  firmId: string,
  payerId: string,
  taxYear: number,
): Promise<{ hasForms: boolean; pdf: Buffer | null; filename: string }> {
  const payer = await db.query.payers.findFirst({ where: and(eq(payers.id, payerId), eq(payers.firmId, firmId)) });
  if (!payer) throw AppError.notFound('Payer');
  const filename = archiveFileName(taxYear, payer.legalName, payer.clientId);

  const forms = await db
    .select({ id: formRecords.id })
    .from(formRecords)
    .where(
      and(
        eq(formRecords.firmId, firmId),
        eq(formRecords.payerId, payerId),
        eq(formRecords.taxYear, taxYear),
        sql`${formRecords.status} != 'corrected'`,
      ),
    );
  if (!forms.length) return { hasForms: false, pdf: null, filename };

  const summary = await renderPayerSummary(db, firmId, payerId, taxYear);
  const formPdfs: Buffer[] = [];
  for (const f of forms) formPdfs.push(await renderPortalPdf(db, firmId, f.id));
  const pdf = await getRenderClient().merge([summary, ...formPdfs]);
  return { hasForms: true, pdf, filename };
}

export { getDb };
