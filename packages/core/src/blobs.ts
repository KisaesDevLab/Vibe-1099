/**
 * Blob store — PDFs, IRIS XML/acks, MO .txt files live in Postgres bytea.
 * Sensitive payloads (W-9 PDFs) are envelope-encrypted before storage.
 */
import { and, eq } from 'drizzle-orm';
import { blobs, type Db } from '@vibe1099/db';
import { getCrypto } from './crypto.js';

export type BlobKind =
  | 'form_pdf'
  | 'batch_pdf'
  | 'w9_pdf'
  | 'iris_xml'
  | 'iris_ack'
  | 'tax1099_payload'
  | 'mo_txt'
  | 'report_pdf'
  | 'export_zip';

export async function putBlob(
  db: Db,
  opts: {
    firmId: string | null;
    kind: BlobKind;
    contentType: string;
    filename?: string;
    bytes: Buffer;
    encrypt?: boolean;
  },
): Promise<string> {
  const stored = opts.encrypt ? Buffer.from(getCrypto().encryptBytes(opts.bytes), 'utf8') : opts.bytes;
  const [row] = await db
    .insert(blobs)
    .values({
      firmId: opts.firmId,
      kind: opts.kind,
      contentType: opts.contentType,
      filename: opts.filename ?? '',
      bytes: stored,
      encrypted: !!opts.encrypt,
      size: opts.bytes.length,
    })
    .returning({ id: blobs.id });
  if (!row) throw new Error('blob insert failed');
  return row.id;
}

/**
 * Fetch a blob, enforcing firm ownership. `firmId` is required so every caller
 * must prove the blob belongs to the requesting firm — prevents cross-firm
 * document (PDF/XML, which carry TINs) disclosure via a guessed/leaked blob id.
 * Pass `null` only for genuinely firm-less blobs.
 */
export async function getBlob(
  db: Db,
  id: string,
  firmId: string | null,
): Promise<{ bytes: Buffer; contentType: string; filename: string; kind: string } | null> {
  const row = await db.query.blobs.findFirst({
    where: firmId == null ? eq(blobs.id, id) : and(eq(blobs.id, id), eq(blobs.firmId, firmId)),
  });
  if (!row) return null;
  const bytes = row.encrypted ? getCrypto().decryptBytes(row.bytes.toString('utf8')) : row.bytes;
  return { bytes, contentType: row.contentType, filename: row.filename, kind: row.kind };
}

export async function deleteBlob(db: Db, id: string): Promise<void> {
  await db.delete(blobs).where(eq(blobs.id, id));
}
