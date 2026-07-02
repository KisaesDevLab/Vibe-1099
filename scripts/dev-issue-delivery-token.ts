/**
 * DEV/verification ONLY: mint a recipient portal token for an existing delivery
 * and persist its hash (mirrors what /deliveries/compose does internally). Needed
 * because scoped tokens now carry a random nonce and cannot be reconstructed.
 * Usage: npx tsx scripts/dev-issue-delivery-token.ts <deliveryId>
 */
import { eq } from 'drizzle-orm';
import { getCrypto } from '../packages/core/src/crypto.js';
import { deliveries, getDb, closeDb } from '../packages/db/src/index.js';

async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id) {
    console.error('usage: dev-issue-delivery-token.ts <deliveryId>');
    process.exit(1);
  }
  const db = getDb();
  const row = await db.query.deliveries.findFirst({ where: eq(deliveries.id, id) });
  if (!row) {
    console.error('delivery not found');
    process.exit(1);
  }
  const crypto = getCrypto();
  const expiresAt = row.tokenExpiresAt ?? new Date(Date.now() + 30 * 86_400_000);
  const token = crypto.signScopedToken('recipient', id, expiresAt);
  await db.update(deliveries).set({ tokenHash: crypto.tokenHash(token), tokenRevokedAt: null }).where(eq(deliveries.id, id));
  console.log(token);
  await closeDb();
}

void main();
