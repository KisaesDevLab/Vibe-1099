/**
 * One-time backfill: envelope-encrypt any filing artifacts that were stored
 * before encryption-at-rest was enforced for TIN-bearing blob kinds
 * (H1 in docs/SECURITY_AUDIT_2026-07.md). Idempotent — only touches rows with
 * `encrypted = false` in the sensitive kind set; safe to re-run.
 *
 * Usage: MASTER_KEY=... DATABASE_URL=... npx tsx scripts/backfill-encrypt-blobs.ts
 */
import { and, eq, inArray } from 'drizzle-orm';
import { getCrypto } from '../packages/core/src/crypto.js';
import { blobs, getDb, closeDb } from '../packages/db/src/index.js';

const SENSITIVE_KINDS = ['iris_xml', 'tax1099_payload', 'mo_txt', 'iris_ack', 'batch_pdf', 'report_pdf', 'w9_pdf', 'form_pdf'];

async function main(): Promise<void> {
  const db = getDb();
  const crypto = getCrypto();
  const rows = await db
    .select({ id: blobs.id, bytes: blobs.bytes })
    .from(blobs)
    .where(and(eq(blobs.encrypted, false), inArray(blobs.kind, SENSITIVE_KINDS)));

  let done = 0;
  for (const row of rows) {
    const enc = Buffer.from(crypto.encryptBytes(row.bytes), 'utf8');
    await db.update(blobs).set({ bytes: enc, encrypted: true }).where(eq(blobs.id, row.id));
    done += 1;
  }
  console.log(`encrypted ${done} plaintext blob(s)`);
  await closeDb();
}

void main();
