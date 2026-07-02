/**
 * Dev/verification helper: reconstruct a recipient portal token from a delivery
 * row (deterministic HMAC over scope.id.expSeconds). Requires MASTER_KEY.
 * Usage: npx tsx scripts/make-portal-token.ts <deliveryId> <tokenExpiresAtISO>
 */
import { CryptoService } from '../packages/core/src/crypto.js';

const [id, exp] = process.argv.slice(2);
if (!id || !exp) {
  console.error('usage: make-portal-token.ts <deliveryId> <expiresAtISO>');
  process.exit(1);
}
const svc = new CryptoService(process.env.MASTER_KEY!);
console.log(svc.signScopedToken('recipient', id, new Date(exp)));
