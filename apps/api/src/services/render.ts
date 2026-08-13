/**
 * Render service (Phase 6): builds template payloads from form records via the
 * registry, with TIN truncation on ALL payee output (payer TIN full per rules).
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
  AppError,
  copyBLabels,
  formatCents,
  formatTin,
  getFormDef,
  maskTin,
  type FormType,
} from '@vibe1099/shared';
import { getCrypto, getRenderClient } from '@vibe1099/core';
import { firms, formRecords, getDb, payers, recipients, type Db } from '@vibe1099/db';

const OMB_BY_TYPE: Record<FormType, string> = {
  NEC: '1545-0116',
  MISC: '1545-0115',
  INT: '1545-0112',
  DIV: '1545-0110',
  '1098': '1545-0901',
};

export interface CopyBOptions {
  variant: 'portal' | 'copy2';
  maskContact?: boolean; // suppress recipient email/phone from printed output
}

function addressLines(addr: Record<string, string>): string[] {
  const lines = [addr['line1'] ?? ''];
  if (addr['line2']) lines.push(addr['line2']);
  lines.push(`${addr['city'] ?? ''}, ${addr['state'] ?? ''} ${addr['zip'] ?? ''}`);
  return lines.filter(Boolean);
}

export async function buildFormPayload(
  db: Db,
  firmId: string,
  formRecordId: string,
  opts: { maskPayerTin?: boolean } = {},
) {
  const record = await db.query.formRecords.findFirst({
    where: and(eq(formRecords.id, formRecordId), eq(formRecords.firmId, firmId)),
  });
  if (!record) throw AppError.notFound('Form record');
  // parties MUST be re-scoped to the firm: a record whose payerId/recipientId was
  // poisoned (e.g. a foreign UUID slipped through a write path) must never cause a
  // cross-firm TIN to be decrypted into a rendered document
  const [payer, recipient, firm] = await Promise.all([
    db.query.payers.findFirst({ where: and(eq(payers.id, record.payerId), eq(payers.firmId, firmId)) }),
    db.query.recipients.findFirst({ where: and(eq(recipients.id, record.recipientId), eq(recipients.firmId, firmId)) }),
    db.query.firms.findFirst({ where: eq(firms.id, firmId) }),
  ]);
  if (!payer || !recipient || !firm) throw AppError.notFound('Form parties');

  const def = getFormDef(record.formType as FormType, record.taxYear);
  const crypto = getCrypto();
  const payerTin = crypto.decrypt(payer.tinEncrypted);

  // corrected form uses the CURRENT record values, marks the CORRECTED checkbox
  const isCorrected = record.correctionSeq > 0 || record.correctionType != null;

  const boxes = def.boxes
    .filter((b) => !b.stateField)
    .map((b) => {
      const v = record.boxValues[b.id];
      return {
        number: b.boxNumber,
        label: b.label,
        kind: b.kind,
        value:
          b.kind === 'cents'
            ? typeof v === 'number' && (v > 0 || isCorrected)
              ? formatCents(v)
              : ''
            : b.kind === 'checkbox'
              ? v === true
              : ((v as string) ?? ''),
      };
    });

  const stateBoxes = def.boxes
    .filter((b) => b.stateField)
    .map((b) => {
      const v = record.boxValues[b.id];
      return {
        number: b.boxNumber,
        label: b.label,
        value: b.kind === 'cents' ? (typeof v === 'number' && v > 0 ? formatCents(v) : '') : ((v as string) ?? ''),
      };
    });

  return {
    record,
    payer,
    recipient,
    firm,
    form: {
      corrected: isCorrected,
      tax_year: record.taxYear,
      form_type: record.formType,
      form_number: record.formType === '1098' ? '1098' : `1099-${record.formType}`,
      form_title: def.title,
      omb: OMB_BY_TYPE[record.formType as FormType],
      copy_label: 'Copy B',
      ...copyBLabels(record.formType as FormType),
      account_number: record.accountNumber,
      second_tin_notice: record.secondTinNotice,
      payer: {
        name: payer.dbaName || payer.legalName,
        address_lines: addressLines(payer.address),
        // payer TIN full per Pub 1179 on firm/staff output; truncated on the
        // client-portal substitute copy (opts.maskPayerTin) for privacy
        tin_display: opts.maskPayerTin ? maskTin(payerTin, payer.tinType) : formatTin(payerTin, payer.tinType),
        phone: payer.phone,
      },
      recipient: {
        name1: recipient.name1,
        name2: recipient.name2,
        address_lines: addressLines(recipient.address),
        tin_masked: maskTin(recipient.tinLast4, recipient.tinType), // ALWAYS truncated
      },
      boxes,
      state_boxes: stateBoxes,
    },
    instructions_key: record.formType.toLowerCase(),
  };
}

/** Portal PDF: Copy B + instruction page(s), 8.5x11 portrait. */
export async function renderPortalPdf(db: Db, firmId: string, formRecordId: string): Promise<Buffer> {
  const payload = await buildFormPayload(db, firmId, formRecordId);
  return getRenderClient().render({
    template: 'copy_b.html',
    data: { form: payload.form, instructions_key: payload.instructions_key },
  });
}

/**
 * Client-portal substitute Copy B: payer AND recipient TINs both truncated for
 * privacy (the client prints this themselves). Clearly labelled a substitute.
 */
export async function renderSubstitutePdf(db: Db, firmId: string, formRecordId: string): Promise<Buffer> {
  const payload = await buildFormPayload(db, firmId, formRecordId, { maskPayerTin: true });
  return getRenderClient().render({
    template: 'copy_b.html',
    data: {
      form: { ...payload.form, copy_label: 'Copy B — Substitute (For Recipient)' },
      instructions_key: payload.instructions_key,
    },
  });
}

/** Copy 2 (state filing copy) — only meaningful when state withholding is present. */
export async function renderCopy2Pdf(db: Db, firmId: string, formRecordId: string): Promise<Buffer> {
  const payload = await buildFormPayload(db, firmId, formRecordId);
  const stw = payload.record.boxValues['stateTaxWithheld'];
  if (typeof stw !== 'number' || stw <= 0) {
    throw AppError.validation('Copy 2 applies only when state tax was withheld on this form');
  }
  return getRenderClient().render({
    template: 'copy_b.html',
    data: {
      form: { ...payload.form, copy_label: 'Copy 2 — To be filed with recipient’s state income tax return' },
      instructions_key: payload.instructions_key,
    },
  });
}

/** Z-fold pressure-seal sheet (duplex pair) for one form. */
export async function renderZfoldSheet(db: Db, firmId: string, formRecordId: string): Promise<Buffer> {
  const payload = await buildFormPayload(db, firmId, formRecordId);
  const firm = payload.firm;
  return getRenderClient().render({
    template: 'zfold_sheet.html',
    data: {
      form: payload.form,
      instructions_key: payload.instructions_key,
      offset_x_in: firm.impositionOffsetX16 / 16,
      offset_y_in: firm.impositionOffsetY16 / 16,
    },
  });
}

/**
 * Client copy: compact multi-up print of forms for the CLIENT'S records — not a
 * filing copy, never furnished to recipients. Grouped per payer (new page per
 * payer); recipient TINs truncated, payer's own TIN full. Ordered payer →
 * recipient for a stable, checkable printout.
 */
export async function renderClientCopyPdf(db: Db, firmId: string, formRecordIds: string[]): Promise<Buffer> {
  const rows = await db
    .select({ id: formRecords.id, payerId: formRecords.payerId, payerName: payers.legalName, recipientName: recipients.name1 })
    .from(formRecords)
    .innerJoin(payers, eq(payers.id, formRecords.payerId))
    .innerJoin(recipients, eq(recipients.id, formRecords.recipientId))
    .where(and(eq(formRecords.firmId, firmId), inArray(formRecords.id, formRecordIds)));
  if (!rows.length) throw AppError.notFound('Forms');
  rows.sort((a, b) => a.payerName.localeCompare(b.payerName) || a.recipientName.localeCompare(b.recipientName));

  interface ClientCopyGroup {
    payer: unknown;
    tax_year: number;
    form_number: string;
    forms: unknown[];
    totalCents: number;
    withheldCents: number;
  }
  const groups = new Map<string, ClientCopyGroup>();
  for (const row of rows) {
    const p = await buildFormPayload(db, firmId, row.id);
    let g = groups.get(row.payerId);
    if (!g) {
      g = { payer: p.form.payer, tax_year: p.form.tax_year, form_number: p.form.form_number, forms: [], totalCents: 0, withheldCents: 0 };
      groups.set(row.payerId, g);
    }
    const boxes = [...p.form.boxes, ...p.form.state_boxes.map((s) => ({ ...s, kind: 'cents' as const }))].filter(
      (b) => (b.kind === 'checkbox' ? b.value === true : b.value !== '' && b.value != null),
    );
    // payer totals (1096-style): payment boxes summed, withholding separate
    const def = getFormDef(p.record.formType as FormType, p.record.taxYear);
    for (const b of def.boxes) {
      if (b.kind !== 'cents' || b.stateField) continue;
      const v = p.record.boxValues[b.id];
      if (typeof v !== 'number') continue;
      if (b.id === 'fedTaxWithheld') g.withheldCents += v;
      else g.totalCents += v;
    }
    g.forms.push({
      recipient: p.form.recipient,
      account_number: p.form.account_number,
      corrected: p.form.corrected,
      boxes,
    });
  }
  const data = {
    groups: [...groups.values()].map((g) => ({
      payer: g.payer,
      tax_year: g.tax_year,
      form_number: g.form_number,
      forms: g.forms,
      total: formatCents(g.totalCents),
      withheld: g.withheldCents > 0 ? formatCents(g.withheldCents) : null,
    })),
  };
  return getRenderClient().render({ template: 'client_copy.html', data });
}

export async function renderTestPattern(db: Db, firmId: string): Promise<Buffer> {
  const firm = await db.query.firms.findFirst({ where: eq(firms.id, firmId) });
  if (!firm) throw AppError.notFound('Firm');
  return getRenderClient().render({
    template: 'test_pattern.html',
    data: {
      offset_x_in: firm.impositionOffsetX16 / 16,
      offset_y_in: firm.impositionOffsetY16 / 16,
      offset_x_16: firm.impositionOffsetX16,
      offset_y_16: firm.impositionOffsetY16,
    },
  });
}
