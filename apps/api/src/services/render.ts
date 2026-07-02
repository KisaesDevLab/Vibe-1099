/**
 * Render service (Phase 6): builds template payloads from form records via the
 * registry, with TIN truncation on ALL payee output (payer TIN full per rules).
 */
import { and, eq } from 'drizzle-orm';
import {
  AppError,
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

export async function buildFormPayload(db: Db, firmId: string, formRecordId: string) {
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
      form_number: `1099-${record.formType}`,
      form_title: def.title,
      omb: OMB_BY_TYPE[record.formType as FormType],
      copy_label: 'Copy B',
      account_number: record.accountNumber,
      second_tin_notice: record.secondTinNotice,
      payer: {
        name: payer.dbaName || payer.legalName,
        address_lines: addressLines(payer.address),
        tin_display: formatTin(payerTin, payer.tinType), // payer TIN in full per Pub 1179
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
      firm_return: {
        name: firm.name,
        address_lines: addressLines(firm.address),
      },
      offset_x_in: firm.impositionOffsetX16 / 16,
      offset_y_in: firm.impositionOffsetY16 / 16,
    },
  });
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
