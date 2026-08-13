/**
 * CLI wrapper for the TaxBandits sandbox test seed (also available in the UI:
 * Settings → Advanced → "Load sandbox test data"). See services/sandbox-seed.ts
 * for the data and simulation-rule documentation.
 *
 * Run: pnpm seed:sandbox   (requires DATABASE_URL + MASTER_KEY)
 */
import { createLogger, loadEnv } from '@vibe1099/core';
import { closeDb, firms, getDb, getPool, runMigrations } from '@vibe1099/db';
import { seedSandboxData, SANDBOX_TAX_YEAR } from './services/sandbox-seed.js';

const log = createLogger('seed-sandbox');

async function main(): Promise<void> {
  const env = loadEnv();
  await runMigrations(getPool(env.DATABASE_URL), (m) => log.info(m));
  const db = getDb();

  const [firm] = await db.select().from(firms).limit(1);
  if (!firm) throw new Error('No firm found — run `pnpm seed` (demo) or `pnpm bootstrap:firm` first.');

  const counts = await seedSandboxData(db, firm.id);
  log.info(`sandbox seed: +${counts.payers} payers, +${counts.recipients} recipients, +${counts.forms} TY${SANDBOX_TAX_YEAR} draft forms (firm ${firm.id})`);
  log.info('All payers default to the TaxBandits provider. Transmit per payer; federal verdicts simulate ~2 minutes after release.');
  log.info('Expected: payers 1–8 accepted (8 has a state rejection on YORK JAMES); payer 9 all rejected; payer 10 = stuck TRANSMITTED, accepted-with-errors, and a TIN-match failure (ELLIS PARK).');
  await closeDb();
}

main().catch((err) => {
  log.fatal(String(err instanceof Error ? err.stack : err));
  process.exit(1);
});
