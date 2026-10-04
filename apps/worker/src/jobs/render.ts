/**
 * Render worker (Phase 6): chunked Z-fold batch rendering. Each chunk renders
 * its forms; the final chunk merges all chunk PDFs + prepends the manifest.
 * 500-form batch target: <60s via chunk parallelism across worker concurrency.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { Job } from 'bullmq';
import { createLogger, getRedis, getRenderClient, notify, putBlob, type RenderBatchJob } from '@vibe1099/core';
import { formRecords, getDb, paperBatches, payers, recipients, firms } from '@vibe1099/db';
import { copyBLabels, maskTin, type FormType, formatCents, getFormDef, formatTin } from '@vibe1099/shared';
import { getCrypto } from '@vibe1099/core';

const log = createLogger('worker:render');

type FormRow = typeof formRecords.$inferSelect;
type PayerRow = typeof payers.$inferSelect;
type RecipientRow = typeof recipients.$inferSelect;
type FirmRow = typeof firms.$inferSelect;

function addressLines(addr: Record<string, string>): string[] {
  const lines = [addr['line1'] ?? ''];
  if (addr['line2']) lines.push(addr['line2']);
  lines.push(`${addr['city'] ?? ''}, ${addr['state'] ?? ''} ${addr['zip'] ?? ''}`);
  return lines.filter(Boolean);
}

/**
 * One chunk's parties, loaded with three `inArray` selects (+ the firm once)
 * instead of four queries per form, and — like the API renderer — re-scoped to
 * the firm so a poisoned payerId/recipientId can never decrypt a cross-firm TIN
 * into a mailed document. Payer TINs are decrypted once per payer, not per form.
 */
async function loadChunk(firmId: string, recordIds: string[]) {
  const db = getDb();
  const records = recordIds.length
    ? await db
        .select()
        .from(formRecords)
        .where(and(inArray(formRecords.id, recordIds), eq(formRecords.firmId, firmId)))
    : [];
  const payerIds = [...new Set(records.map((r) => r.payerId))];
  const recipientIds = [...new Set(records.map((r) => r.recipientId))];
  const [payerRows, recipientRows, firm] = await Promise.all([
    payerIds.length ? db.select().from(payers).where(and(inArray(payers.id, payerIds), eq(payers.firmId, firmId))) : Promise.resolve([] as PayerRow[]),
    recipientIds.length
      ? db.select().from(recipients).where(and(inArray(recipients.id, recipientIds), eq(recipients.firmId, firmId)))
      : Promise.resolve([] as RecipientRow[]),
    db.query.firms.findFirst({ where: eq(firms.id, firmId) }),
  ]);
  if (!firm) throw new Error('firm missing');
  const byId = new Map(records.map((r) => [r.id, r]));
  const payerById = new Map(payerRows.map((p) => [p.id, p]));
  const recipientById = new Map(recipientRows.map((r) => [r.id, r]));
  const crypto = getCrypto();
  const payerTin = new Map(payerRows.map((p) => [p.id, formatTin(crypto.decrypt(p.tinEncrypted), p.tinType)]));
  return { firm, byId, payerById, recipientById, payerTin };
}

function renderZfold(
  record: FormRow,
  payer: PayerRow,
  payerTinDisplay: string,
  recipient: RecipientRow,
  firm: FirmRow,
): Promise<Buffer> {
  const def = getFormDef(record.formType as FormType, record.taxYear);
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
        kind: b.kind,
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
        // registry-driven: the same form number / OMB the on-demand API renderer prints
        form_number: def.formNumber,
        form_title: def.title,
        omb: def.omb,
        copy_label: 'Copy B',
        // _form_grid.html reads these under StrictUndefined — omitting them
        // crashes every batch render (the bug that broke paper batches).
        ...copyBLabels(record.formType as FormType),
        account_number: record.accountNumber,
        second_tin_notice: record.secondTinNotice,
        payer: {
          name: payer.dbaName || payer.legalName,
          address_lines: addressLines(payer.address),
          tin_display: payerTinDisplay,
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
  const claimKey = `batch:${data.paperBatchId}:assemble`;

  try {
    const chunk = await loadChunk(data.firmId, data.formRecordIds);
    const pdfs: Buffer[] = [];
    for (const recordId of data.formRecordIds) {
      const record = chunk.byId.get(recordId);
      if (!record) throw new Error(`record ${recordId} missing`);
      const payer = chunk.payerById.get(record.payerId);
      const recipient = chunk.recipientById.get(record.recipientId);
      if (!payer || !recipient) throw new Error('form parties missing');
      pdfs.push(await renderZfold(record, payer, chunk.payerTin.get(payer.id) ?? '', recipient, chunk.firm));
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

    // Exactly ONE chunk assembles: with worker concurrency, two last chunks can
    // both observe hlen === chunkCount (hset → hlen is not atomic). Without this
    // claim both merged, the loser then found the hash deleted, threw, and
    // flipped an already-built batch to 'failed'.
    const claimed = await redis.set(claimKey, String(data.chunkIndex), 'EX', 3600, 'NX');
    if (claimed !== 'OK') {
      log.info({ batch: data.paperBatchId, chunk: data.chunkIndex }, 'another chunk is assembling this batch — skipping');
      return;
    }

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
      const formType = r?.f.formType;
      return {
        n: idx + 1,
        payer: r?.payerName ?? '?',
        recipient: r?.recipientName ?? '?',
        form_type: formType ?? '?',
        form_number: r ? getFormDef(r.f.formType as FormType, r.f.taxYear).formNumber : '?',
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
          order_note: 'Deterministic order: payer legal name → recipient name. Simplex: each form = one sheet (instructions / form / mailer face with payer return address).',
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
      encrypt: true,
    });
    await db
      .update(paperBatches)
      .set({ pdfBlobId, pageCount, status: 'built' })
      .where(eq(paperBatches.id, data.paperBatchId));
    await redis.del(chunkKey, claimKey);
    log.info({ batch: data.paperBatchId, pages: pageCount }, 'batch built');
    // notification is best-effort — never let it fail a successfully-built batch
    await notify(db, {
      firmId: data.firmId,
      kind: 'batch',
      severity: 'success',
      title: 'Paper batch ready',
      body: `${batch.label} — ${batch.formCount} form(s), ${pageCount} pages. Download & print.`,
      link: '/batches',
      entityType: 'paper_batch',
      entityId: data.paperBatchId,
    }).catch((e) => log.warn({ err: (e as Error).message }, 'batch notify failed (non-fatal)'));
  } catch (err) {
    // release the assembly claim so a retry can assemble, and never demote a
    // batch that another chunk already finished
    await redis.del(claimKey).catch(() => undefined);
    await db
      .update(paperBatches)
      .set({ status: 'failed' })
      .where(and(eq(paperBatches.id, data.paperBatchId), eq(paperBatches.status, 'building')));
    throw err;
  }
}
