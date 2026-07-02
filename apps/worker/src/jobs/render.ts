/**
 * Render worker (Phase 6): chunked Z-fold batch rendering. Each chunk renders
 * its forms; the final chunk merges all chunk PDFs + prepends the manifest.
 * 500-form batch target: <60s via chunk parallelism across worker concurrency.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { Job } from 'bullmq';
import { createLogger, getRedis, getRenderClient, notify, putBlob, type RenderBatchJob } from '@vibe1099/core';
import { formRecords, getDb, paperBatches, payers, recipients, firms } from '@vibe1099/db';
import { maskTin, type FormType, formatCents, getFormDef, formatTin } from '@vibe1099/shared';
import { getCrypto } from '@vibe1099/core';

const log = createLogger('worker:render');

const OMB_BY_TYPE: Record<string, string> = {
  NEC: '1545-0116',
  MISC: '1545-0115',
  INT: '1545-0112',
  DIV: '1545-0110',
};

function addressLines(addr: Record<string, string>): string[] {
  const lines = [addr['line1'] ?? ''];
  if (addr['line2']) lines.push(addr['line2']);
  lines.push(`${addr['city'] ?? ''}, ${addr['state'] ?? ''} ${addr['zip'] ?? ''}`);
  return lines.filter(Boolean);
}

async function renderZfoldForRecord(recordId: string, firmId: string): Promise<Buffer> {
  const db = getDb();
  const record = await db.query.formRecords.findFirst({ where: eq(formRecords.id, recordId) });
  if (!record) throw new Error(`record ${recordId} missing`);
  const [payer, recipient, firm] = await Promise.all([
    db.query.payers.findFirst({ where: eq(payers.id, record.payerId) }),
    db.query.recipients.findFirst({ where: eq(recipients.id, record.recipientId) }),
    db.query.firms.findFirst({ where: eq(firms.id, firmId) }),
  ]);
  if (!payer || !recipient || !firm) throw new Error('form parties missing');
  const def = getFormDef(record.formType as FormType, record.taxYear);
  const crypto = getCrypto();
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

  return getRenderClient().render({
    template: 'zfold_sheet.html',
    data: {
      form: {
        corrected: isCorrected,
        tax_year: record.taxYear,
        form_type: record.formType,
        form_number: `1099-${record.formType}`,
        form_title: def.title,
        omb: OMB_BY_TYPE[record.formType] ?? '',
        copy_label: 'Copy B',
        account_number: record.accountNumber,
        second_tin_notice: record.secondTinNotice,
        payer: {
          name: payer.dbaName || payer.legalName,
          address_lines: addressLines(payer.address),
          tin_display: formatTin(crypto.decrypt(payer.tinEncrypted), payer.tinType),
          phone: payer.phone,
        },
        recipient: {
          name1: recipient.name1,
          name2: recipient.name2,
          address_lines: addressLines(recipient.address),
          tin_masked: maskTin(recipient.tinLast4, recipient.tinType),
        },
        boxes,
        state_boxes: stateBoxes,
      },
      instructions_key: record.formType.toLowerCase(),
      firm_return: { name: firm.name, address_lines: addressLines(firm.address) },
      offset_x_in: firm.impositionOffsetX16 / 16,
      offset_y_in: firm.impositionOffsetY16 / 16,
    },
  });
}

export async function handleRenderJob(job: Job): Promise<void> {
  const data = job.data as RenderBatchJob;
  if (data.kind !== 'paper_batch') return;
  const db = getDb();
  const redis = getRedis();
  const chunkKey = `batch:${data.paperBatchId}:chunks`;

  try {
    const pdfs: Buffer[] = [];
    for (const recordId of data.formRecordIds) {
      pdfs.push(await renderZfoldForRecord(recordId, data.firmId));
    }
    // stash chunk PDFs in redis (base64) until all chunks land
    await redis.hset(
      chunkKey,
      String(data.chunkIndex),
      JSON.stringify(pdfs.map((p) => p.toString('base64'))),
    );
    await redis.expire(chunkKey, 3600);

    const done = await redis.hlen(chunkKey);
    log.info({ batch: data.paperBatchId, chunk: data.chunkIndex, done, total: data.chunkCount }, 'chunk rendered');
    if (done < data.chunkCount) return;

    // final chunk: assemble manifest + merge in deterministic chunk order
    const batch = await db.query.paperBatches.findFirst({ where: eq(paperBatches.id, data.paperBatchId) });
    if (!batch) throw new Error('batch missing');

    const rows = await db
      .select({ f: formRecords, payerName: payers.legalName, recipientName: recipients.name1 })
      .from(formRecords)
      .innerJoin(payers, eq(payers.id, formRecords.payerId))
      .innerJoin(recipients, eq(recipients.id, formRecords.recipientId))
      .where(and(inArray(formRecords.id, batch.formRecordIds), eq(formRecords.firmId, data.firmId)));
    const rmap = new Map(rows.map((r) => [r.f.id, r]));
    const manifestRows = batch.formRecordIds.map((id, idx) => {
      const r = rmap.get(id);
      return {
        n: idx + 1,
        payer: r?.payerName ?? '?',
        recipient: r?.recipientName ?? '?',
        form_type: r?.f.formType ?? '?',
        sheet: idx + 2, // sheet 1 = manifest
      };
    });
    const manifestPdf = await getRenderClient().render({
      template: 'batch_manifest.html',
      data: {
        batch: {
          label: batch.label,
          tax_year: batch.taxYear,
          form_count: batch.formCount,
          created_at: batch.createdAt.toISOString().slice(0, 16).replace('T', ' '),
          order_note: 'Deterministic order: payer legal name → recipient name. Duplex: each form = front (mailer+form) / back (instructions).',
        },
        rows: manifestRows,
      },
    });

    const allPdfs: Buffer[] = [manifestPdf];
    for (let i = 0; i < data.chunkCount; i++) {
      const raw = await redis.hget(chunkKey, String(i));
      if (!raw) throw new Error(`chunk ${i} missing from assembly`);
      for (const b64 of JSON.parse(raw) as string[]) allPdfs.push(Buffer.from(b64, 'base64'));
    }
    const { pdf, pageCount } = await getRenderClient().mergeWithCount(allPdfs);

    const pdfBlobId = await putBlob(db, {
      firmId: data.firmId,
      kind: 'batch_pdf',
      contentType: 'application/pdf',
      filename: `${batch.label.replace(/[^\w.-]+/g, '_')}.pdf`,
      bytes: pdf,
    });
    await db
      .update(paperBatches)
      .set({ pdfBlobId, pageCount, status: 'built' })
      .where(eq(paperBatches.id, data.paperBatchId));
    await redis.del(chunkKey);
    log.info({ batch: data.paperBatchId, pages: pageCount }, 'batch built');
    await notify(db, {
      firmId: data.firmId,
      kind: 'batch',
      severity: 'success',
      title: 'Paper batch ready',
      body: `${batch.label} — ${batch.formCount} form(s), ${pageCount} pages. Download & print.`,
      link: '/batches',
      entityType: 'paper_batch',
      entityId: data.paperBatchId,
    });
  } catch (err) {
    await db.update(paperBatches).set({ status: 'failed' }).where(eq(paperBatches.id, data.paperBatchId));
    throw err;
  }
}
