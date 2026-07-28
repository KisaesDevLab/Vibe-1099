/**
 * Production first-run bootstrap (appliance install). Idempotent — safe to re-run.
 *
 * This is NOT `seed.ts`: the seed creates a demo firm with a PUBLISHED password and
 * fixture recipients/records (fake TINs), for evaluation only. Until now it was also the
 * only code path that created a user at all — so a production install had no way to sign
 * in without polluting the database with demo data. This creates the REAL firm and one
 * admin login, nothing else: no payers, no recipients, no form records.
 *
 * Semantics (mirrors the suite convention set by Vibe-AI-Router's bootstrap-firm):
 *   - firm:  the first firm row IS the firm (single-firm appliance). Created with
 *            FIRM_NAME if none exists; never modified if one does. EIN/address start
 *            empty — they are firm data the operator completes in Settings, not
 *            deployment config.
 *   - admin: created if missing; if it exists the password is RE-APPLIED, so the value
 *            the appliance generated (and printed to CREDENTIALS.txt) always wins.
 *            Nothing else about an existing user is touched (TOTP stays enabled).
 *
 * Env:
 *   DATABASE_URL              required
 *   MASTER_KEY                required (loadEnv validates it)
 *   VIBE1099_ADMIN_EMAIL      required — the first admin login
 *   VIBE1099_ADMIN_PASSWORD   required — generated + preserved by the appliance
 *   FIRM_NAME                 default "Firm"
 *
 * Run: pnpm bootstrap:firm   (or: pnpm --filter @vibe1099/api exec tsx src/ops/bootstrap-firm.ts)
 */
import { hash as argonHash } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { createLogger, loadEnv } from '@vibe1099/core';
import { closeDb, firms, getDb, getPool, runMigrations, users } from '@vibe1099/db';
import { ARGON_OPTS } from '../routes/auth.js';

const log = createLogger('bootstrap-firm');

async function main(): Promise<void> {
  const env = loadEnv();

  const firmName = process.env['FIRM_NAME']?.trim() || 'Firm';
  // Login lowercases the email before lookup — store it lowercased so the
  // credentials the appliance prints match what the form accepts verbatim.
  const adminEmail = process.env['VIBE1099_ADMIN_EMAIL']?.trim().toLowerCase();
  const adminPassword = process.env['VIBE1099_ADMIN_PASSWORD'];
  if (!adminEmail || !adminPassword) {
    throw new Error('VIBE1099_ADMIN_EMAIL and VIBE1099_ADMIN_PASSWORD are required');
  }
  if (adminPassword.length < 12) {
    // The login route enforces nothing here; refuse at install time instead —
    // a weak first-admin password on a box full of TINs is not a default we accept.
    throw new Error('VIBE1099_ADMIN_PASSWORD must be at least 12 characters');
  }

  await runMigrations(getPool(env.DATABASE_URL), (m) => log.info(m));
  const db = getDb();

  // 1 — firm (single-firm appliance; the first firm row IS the firm)
  const existingFirm = (await db.select().from(firms).limit(1))[0];
  const firm =
    existingFirm ??
    (
      await db
        .insert(firms)
        .values({
          name: firmName,
          // Firm data, not deployment config: completed in Settings → Firm
          // (EIN is required for filing and validated on that path).
          ein: '',
          address: {},
        })
        .returning()
    )[0];
  if (!firm) throw new Error('firm creation failed');
  log.info(`firm: ${firm.name} (${existingFirm ? 'existing' : 'created'})`);

  // 2 — admin login (password always re-applied so the appliance's generated value wins)
  const passwordHash = await argonHash(adminPassword, ARGON_OPTS);
  const existingUser = await db.query.users.findFirst({ where: eq(users.email, adminEmail) });
  if (existingUser) {
    await db.update(users).set({ passwordHash, active: true }).where(eq(users.id, existingUser.id));
    log.info(`admin: ${adminEmail} (existing — password re-applied)`);
  } else {
    await db.insert(users).values({
      firmId: firm.id,
      email: adminEmail,
      name: 'Administrator',
      passwordHash,
      role: 'admin',
    });
    log.info(`admin: ${adminEmail} (created)`);
  }

  log.info('bootstrap complete.');
  await closeDb();
}

main().catch((err: unknown) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
