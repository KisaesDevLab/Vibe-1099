/**
 * TaxBandits SANDBOX test data: 10 payers + 30 recipients + TY2026 draft forms
 * whose TINs encode the sandbox simulation rules
 * (developer.taxbandits.com/docs/simulation/…) so transmitting them exercises
 * every outcome path. Federal verdicts simulate ~2 minutes after release:
 *
 *   Recipient TIN ends …200/201/202/412/413  → ACCEPTED
 *   …400 → REJECTED (TIN error)      …401 → REJECTED (huge amount reported)
 *   …405 → REJECTED (excess withholding)     …410 → stays TRANSMITTED forever
 *   …414 → ACCEPTEDWITHERRORS        …406 → ACCEPTED + state rejection
 *   …000 → TIN MATCHING fails (Failed verdict)
 *
 * Idempotent: payers matched by legal name, recipients by TIN hash, forms by
 * (payer, recipient, year, type). All TINs/names are fabricated. Refuses to run
 * while the firm's TaxBandits environment is PRODUCTION — test data must never
 * be transmittable as real filings.
 */
import { and, eq } from 'drizzle-orm';
import { AppError, tinLast4 } from '@vibe1099/shared';
import { getCrypto } from '@vibe1099/core';
import { firms, formRecords, payers, recipients, type Db } from '@vibe1099/db';

export const SANDBOX_TAX_YEAR = 2026;

interface PayeeDef {
  tin: string;
  tinType: 'SSN' | 'EIN';
  name1: string;
  formType: 'NEC' | 'MISC';
  boxValues: Record<string, number | string>;
  /** why this TIN — mirrors the sandbox simulation table */
  purpose: string;
}
interface PayerDef {
  legalName: string;
  ein: string;
  city: string;
  payees: PayeeDef[];
}

export const SANDBOX_PAYERS: PayerDef[] = [
  {
    legalName: 'SUNRISE LANDSCAPING LLC', ein: '431000001', city: 'Kansas City',
    payees: [
      { tin: '400210200', tinType: 'SSN', name1: 'ALEX MASON', formType: 'NEC', boxValues: { box1: 840000 }, purpose: 'accepted (…200)' },
      { tin: '400210201', tinType: 'SSN', name1: 'BLAKE OWENS', formType: 'NEC', boxValues: { box1: 1275050 }, purpose: 'accepted (…201)' },
      { tin: '400210202', tinType: 'SSN', name1: 'CAMERON PIKE', formType: 'NEC', boxValues: { box1: 330000 }, purpose: 'accepted (…202)' },
    ],
  },
  {
    legalName: 'HARVEST FARMS LLC', ein: '431000002', city: 'Pierce City',
    payees: [
      { tin: '400210412', tinType: 'SSN', name1: 'DEVON QUINN', formType: 'NEC', boxValues: { box1: 510000 }, purpose: 'accepted (…412)' },
      { tin: '400210413', tinType: 'SSN', name1: 'EMERY REESE', formType: 'NEC', boxValues: { box1: 2200000 }, purpose: 'accepted (…413)' },
      { tin: '400211200', tinType: 'SSN', name1: 'FINLEY SHAW', formType: 'NEC', boxValues: { box1: 78000 }, purpose: 'accepted (…200)' },
    ],
  },
  {
    legalName: 'BLUE RIVER BUILDERS INC', ein: '431000003', city: 'Springfield',
    payees: [
      { tin: '400211201', tinType: 'SSN', name1: 'GRAY THOMPSON', formType: 'NEC', boxValues: { box1: 1522575 }, purpose: 'accepted (…201)' },
      { tin: '400211202', tinType: 'SSN', name1: 'HAYDEN UPTON', formType: 'NEC', boxValues: { box1: 900000 }, purpose: 'accepted (…202)' },
      { tin: '400211412', tinType: 'SSN', name1: 'IRIS VALDEZ', formType: 'NEC', boxValues: { box1: 64600 }, purpose: 'accepted (…412)' },
    ],
  },
  {
    legalName: 'CEDAR POINT CLINIC PC', ein: '431000004', city: 'Columbia',
    payees: [
      { tin: '400211413', tinType: 'SSN', name1: 'JULES WARNER', formType: 'NEC', boxValues: { box1: 3000000 }, purpose: 'accepted (…413)' },
      { tin: '400212200', tinType: 'SSN', name1: 'KAI XIONG', formType: 'NEC', boxValues: { box1: 485000 }, purpose: 'accepted (…200)' },
      { tin: '400212201', tinType: 'SSN', name1: 'LOGAN YOUNG', formType: 'NEC', boxValues: { box1: 240000 }, purpose: 'accepted (…201)' },
    ],
  },
  {
    legalName: 'MAPLE STREET MEDIA LLC', ein: '431000005', city: 'St. Louis',
    payees: [
      { tin: '400212202', tinType: 'SSN', name1: 'MICA ZHANG', formType: 'NEC', boxValues: { box1: 767525 }, purpose: 'accepted (…202)' },
      { tin: '400212412', tinType: 'SSN', name1: 'NOEL ARCHER', formType: 'NEC', boxValues: { box1: 195000 }, purpose: 'accepted (…412)' },
      { tin: '400212413', tinType: 'SSN', name1: 'OAKLEY BRANT', formType: 'NEC', boxValues: { box1: 66000 }, purpose: 'accepted (…413)' },
    ],
  },
  {
    legalName: 'PRAIRIE LOGISTICS CORP', ein: '431000006', city: 'Joplin',
    payees: [
      { tin: '400213200', tinType: 'SSN', name1: 'QUINCY DALE', formType: 'NEC', boxValues: { box1: 1111111 }, purpose: 'accepted (…200)' },
      { tin: '451000201', tinType: 'EIN', name1: 'REDWOOD REPAIRS LLC', formType: 'NEC', boxValues: { box1: 600000 }, purpose: 'accepted EIN payee (…201)' },
      { tin: '451000202', tinType: 'EIN', name1: 'SILVER CREEK WELDING LLC', formType: 'NEC', boxValues: { box1: 1350000 }, purpose: 'accepted EIN payee (…202)' },
    ],
  },
  {
    legalName: 'OZARK PROPERTIES LP', ein: '431000007', city: 'Branson',
    payees: [
      { tin: '400213201', tinType: 'SSN', name1: 'TATUM ELLIS', formType: 'MISC', boxValues: { box1: 2400000 }, purpose: 'accepted rents (…201)' },
      { tin: '400213202', tinType: 'SSN', name1: 'UMA FROST', formType: 'MISC', boxValues: { box1: 1860000 }, purpose: 'accepted rents (…202)' },
      { tin: '400213412', tinType: 'SSN', name1: 'VAL GIBSON', formType: 'MISC', boxValues: { box1: 720000 }, purpose: 'accepted rents (…412)' },
    ],
  },
  {
    legalName: 'RIVERBEND ORCHARDS LLC', ein: '431000008', city: 'Wentworth',
    payees: [
      { tin: '400213413', tinType: 'SSN', name1: 'WREN HOLT', formType: 'MISC', boxValues: { box1: 1200000 }, purpose: 'accepted rents (…413)' },
      { tin: '400214200', tinType: 'SSN', name1: 'XEN IRWIN', formType: 'MISC', boxValues: { box3: 250000 }, purpose: 'accepted other income (…200)' },
      {
        tin: '400214406', tinType: 'SSN', name1: 'YORK JAMES', formType: 'MISC',
        boxValues: { box1: 960000, stateTaxWithheld: 48000, stateIncome: 960000, stateCode: 'MO', statePayerStateNo: '87654321' },
        purpose: 'federal ACCEPTED + STATE rejection "State Acc Number" (…406) — exercises the States block',
      },
    ],
  },
  {
    legalName: 'GATEWAY CONSULTING GROUP INC', ein: '431000009', city: 'Independence',
    payees: [
      { tin: '400214400', tinType: 'SSN', name1: 'ZION KELLER', formType: 'NEC', boxValues: { box1: 500000 }, purpose: 'REJECTED — TIN error (…400)' },
      { tin: '400214401', tinType: 'SSN', name1: 'ASH LANDRY', formType: 'NEC', boxValues: { box1: 999999999 }, purpose: 'REJECTED — huge amount reported (…401)' },
      { tin: '400214405', tinType: 'SSN', name1: 'BRIAR MOSS', formType: 'NEC', boxValues: { box1: 200000, fedTaxWithheld: 150000 }, purpose: 'REJECTED — excess tax withholding (…405)' },
    ],
  },
  {
    legalName: 'TWIN OAKS VENTURES LLC', ein: '431000010', city: 'Liberty',
    payees: [
      { tin: '400214410', tinType: 'SSN', name1: 'CLEO NASH', formType: 'NEC', boxValues: { box1: 300000 }, purpose: 'stays TRANSMITTED forever (…410) — stuck-status monitoring' },
      { tin: '400214414', tinType: 'SSN', name1: 'DREW ORTIZ', formType: 'NEC', boxValues: { box1: 420000 }, purpose: 'ACCEPTEDWITHERRORS (…414)' },
      { tin: '400215000', tinType: 'SSN', name1: 'ELLIS PARK', formType: 'NEC', boxValues: { box1: 180000 }, purpose: 'TIN MATCHING fails (…000) — run TIN check on this one' },
    ],
  },
];

export interface SandboxSeedCounts {
  payers: number;
  recipients: number;
  forms: number;
}

export async function seedSandboxData(db: Db, firmId: string): Promise<SandboxSeedCounts> {
  const firm = await db.query.firms.findFirst({ where: eq(firms.id, firmId) });
  if (!firm) throw AppError.notFound('Firm');
  // Safety interlock: never stage test data that could transmit as REAL filings.
  if (firm.taxbanditsEnvironment === 'production') {
    throw AppError.state(
      'TaxBandits is set to PRODUCTION — sandbox test data would transmit as real filings. Switch Settings → E-file → TaxBandits environment to sandbox first.',
    );
  }

  const crypto = getCrypto();
  const counts: SandboxSeedCounts = { payers: 0, recipients: 0, forms: 0 };
  let streetNo = 500;

  for (const p of SANDBOX_PAYERS) {
    let payer = await db.query.payers.findFirst({ where: and(eq(payers.firmId, firmId), eq(payers.legalName, p.legalName)) });
    if (!payer) {
      const [row] = await db
        .insert(payers)
        .values({
          firmId,
          legalName: p.legalName,
          tinEncrypted: crypto.encrypt(p.ein),
          tinType: 'EIN',
          tinLast4: p.ein.slice(-4),
          address: { line1: `${streetNo} Commerce Way`, city: p.city, state: 'MO', zip: '64106' },
          phone: '8165550100',
          contactEmail: 'owner@example.com',
          defaultFormTypes: [p.payees[0]!.formType],
          filingProviderOverride: 'taxbandits',
        })
        .returning();
      payer = row;
      counts.payers++;
    }
    if (!payer) continue;

    for (const pe of p.payees) {
      const tinHash = crypto.tinHash(pe.tin, firmId, pe.tinType);
      let recip = await db.query.recipients.findFirst({ where: and(eq(recipients.firmId, firmId), eq(recipients.tinHash, tinHash)) });
      if (!recip) {
        const [row] = await db
          .insert(recipients)
          .values({
            firmId,
            tinEncrypted: crypto.encrypt(pe.tin),
            tinHash,
            tinType: pe.tinType,
            tinLast4: tinLast4(pe.tin),
            name1: pe.name1,
            address: { line1: `${streetNo++} Oak St`, city: p.city, state: 'MO', zip: '64100' },
            email: counts.recipients % 3 === 0 ? `sandbox${counts.recipients}@example.com` : null,
            w9Status: pe.purpose.includes('TIN MATCHING') ? 'none' : 'on_file',
            createdFrom: 'staff',
          })
          .returning();
        recip = row;
        counts.recipients++;
      }
      if (!recip) continue;

      const existingForm = await db.query.formRecords.findFirst({
        where: and(
          eq(formRecords.firmId, firmId),
          eq(formRecords.payerId, payer.id),
          eq(formRecords.recipientId, recip.id),
          eq(formRecords.taxYear, SANDBOX_TAX_YEAR),
          eq(formRecords.formType, pe.formType),
        ),
      });
      if (existingForm) continue;
      await db.insert(formRecords).values({
        firmId,
        payerId: payer.id,
        recipientId: recip.id,
        taxYear: SANDBOX_TAX_YEAR,
        formType: pe.formType,
        boxValues: pe.boxValues,
        moSource: false,
        status: 'draft',
        notes: `Sandbox simulation: ${pe.purpose}`,
      });
      counts.forms++;
    }
  }
  return counts;
}
