/**
 * Seed script (Phase 1): demo firm, admin user, 2 payers, 12 recipients,
 * sample NEC/MISC/INT/DIV records. Idempotent — skips when a firm exists.
 *
 * Run: pnpm seed   (requires DATABASE_URL + MASTER_KEY)
 * Demo login: admin@demo.firm / vibe1099-demo-password
 */
import { hash as argonHash } from '@node-rs/argon2';
import { createLogger, getCrypto, loadEnv } from '@vibe1099/core';
import { closeDb, firms, formRecords, getDb, getPool, payers, recipients, runMigrations, users } from '@vibe1099/db';
import { tinLast4 } from '@vibe1099/shared';
import { ARGON_OPTS } from './routes/auth.js';

const log = createLogger('seed');

const DEMO_RECIPIENTS: Array<{ tin: string; tinType: 'SSN' | 'EIN'; name1: string; city: string; formType: 'NEC' | 'MISC' | 'INT' | 'DIV'; cents: number }> = [
  { tin: '400111222', tinType: 'SSN', name1: 'JORDAN ABLE', city: 'Kansas City', formType: 'NEC', cents: 1250000 },
  { tin: '400111333', tinType: 'SSN', name1: 'CASEY BAKER', city: 'Springfield', formType: 'NEC', cents: 340000 },
  { tin: '400111444', tinType: 'SSN', name1: 'RILEY CARSON', city: 'Columbia', formType: 'NEC', cents: 8125050 },
  { tin: '451234567', tinType: 'EIN', name1: 'DELTA DRYWALL LLC', city: 'Independence', formType: 'NEC', cents: 2200000 },
  { tin: '400111555', tinType: 'SSN', name1: 'MORGAN EWING', city: 'St. Louis', formType: 'MISC', cents: 1800000 },
  { tin: '452345678', tinType: 'EIN', name1: 'FOXTROT PROPERTIES LP', city: 'Lees Summit', formType: 'MISC', cents: 5400000 },
  { tin: '400111666', tinType: 'SSN', name1: 'AVERY GOLDEN', city: 'Joplin', formType: 'MISC', cents: 96000 },
  { tin: '400111777', tinType: 'SSN', name1: 'HARPER INMAN', city: 'Kansas City', formType: 'INT', cents: 152575 },
  { tin: '453456789', tinType: 'EIN', name1: 'JULIETT HOLDINGS INC', city: 'Overland Park', formType: 'INT', cents: 890025 },
  { tin: '400111888', tinType: 'SSN', name1: 'KENDALL LOPEZ', city: 'Blue Springs', formType: 'DIV', cents: 460010 },
  { tin: '400111999', tinType: 'SSN', name1: 'PARKER MILLS', city: 'Liberty', formType: 'DIV', cents: 2350000 },
  { tin: '454567890', tinType: 'EIN', name1: 'NOVEMBER TRUST', city: 'Chesterfield', formType: 'DIV', cents: 12500000 },
];

function primaryBoxFor(formType: string): string {
  return formType === 'DIV' ? 'box1a' : 'box1';
}

async function main(): Promise<void> {
  const env = loadEnv();
  await runMigrations(getPool(env.DATABASE_URL), (m) => log.info(m));
  const db = getDb();
  const crypto = getCrypto();

  const existing = await db.select().from(firms).limit(1);
  if (existing.length) {
    log.info('firm already exists — seed skipped');
    await closeDb();
    return;
  }

  const [firm] = await db
    .insert(firms)
    .values({
      name: 'Demo CPA Firm LLC',
      ein: '431234567',
      address: { line1: '100 Main St', city: 'Kansas City', state: 'MO', zip: '64105' },
      phone: '8165551234',
      moWithholdingId: '12345678',
    })
    .returning({ id: firms.id });
  if (!firm) throw new Error('firm seed failed');

  await db.insert(users).values([
    {
      firmId: firm.id,
      email: 'admin@demo.firm',
      name: 'Demo Admin',
      role: 'admin',
      passwordHash: await argonHash('vibe1099-demo-password', ARGON_OPTS),
    },
    {
      firmId: firm.id,
      email: 'preparer@demo.firm',
      name: 'Demo Preparer',
      role: 'preparer',
      passwordHash: await argonHash('vibe1099-demo-password', ARGON_OPTS),
    },
    {
      firmId: firm.id,
      email: 'reviewer@demo.firm',
      name: 'Demo Reviewer',
      role: 'reviewer',
      passwordHash: await argonHash('vibe1099-demo-password', ARGON_OPTS),
    },
  ]);

  const payerDefs = [
    { legalName: 'ACME CONSTRUCTION LLC', tin: '431111111', city: 'Kansas City' },
    { legalName: 'BRIGHTSIDE MEDICAL GROUP PC', tin: '432222222', city: 'St. Louis' },
  ];
  const payerIds: string[] = [];
  for (const p of payerDefs) {
    const [row] = await db
      .insert(payers)
      .values({
        firmId: firm.id,
        legalName: p.legalName,
        tinEncrypted: crypto.encrypt(p.tin),
        tinType: 'EIN',
        tinLast4: p.tin.slice(-4),
        address: { line1: '200 Commerce Way', city: p.city, state: 'MO', zip: '64106' },
        phone: '8165559876',
        contactEmail: 'owner@example.com',
        moWithholdingId: '87654321',
        moSourceDefault: true,
      })
      .returning({ id: payers.id });
    if (row) payerIds.push(row.id);
  }

  const taxYear = 2026;
  let i = 0;
  for (const r of DEMO_RECIPIENTS) {
    const [recip] = await db
      .insert(recipients)
      .values({
        firmId: firm.id,
        tinEncrypted: crypto.encrypt(r.tin),
        tinHash: crypto.tinHash(r.tin),
        tinType: r.tinType,
        tinLast4: tinLast4(r.tin),
        name1: r.name1,
        address: { line1: `${100 + i} Oak St`, city: r.city, state: 'MO', zip: '64100' },
        email: i % 3 === 0 ? `recipient${i}@example.com` : null,
        mobile: i % 3 === 1 ? `+18165550${String(100 + i)}` : null,
        w9Status: i % 4 === 0 ? 'on_file' : 'none',
        createdFrom: 'staff',
      })
      .returning({ id: recipients.id });
    if (!recip) continue;
    const payerId = payerIds[i % payerIds.length]!;
    await db.insert(formRecords).values({
      firmId: firm.id,
      payerId,
      recipientId: recip.id,
      taxYear,
      formType: r.formType,
      boxValues: { [primaryBoxFor(r.formType)]: r.cents },
      moSource: true,
      status: 'draft',
    });
    i++;
  }

  log.info(`seeded: firm ${firm.id}, ${payerIds.length} payers, ${DEMO_RECIPIENTS.length} recipients + form records (TY${taxYear})`);
  log.info('demo logins: admin@demo.firm / preparer@demo.firm / reviewer@demo.firm — password: vibe1099-demo-password');
  await closeDb();
}

main().catch((err) => {
  log.fatal(String(err instanceof Error ? err.stack : err));
  process.exit(1);
});
