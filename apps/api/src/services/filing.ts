/**
 * Filing-provider resolution + config (Tax1099 Phase 1).
 *
 * Provider is chosen per-payer, falling back to the firm default. IRIS config
 * (TCC/JWK) is only required for IRIS payers; Tax1099 payers need only the
 * firm's Tax1099 app key — so an entity can e-file with NO IRS TCC of its own.
 */
import { eq } from 'drizzle-orm';
import { AppError, ErrorCodes } from '@vibe1099/shared';
import { getCrypto, loadEnv, Tax1099Client, tax1099Endpoints, type FilingProviderKind } from '@vibe1099/core';
import { firms, payers, getDb, type Db } from '@vibe1099/db';

export async function resolveProviderKind(db: Db, firmId: string, payerId: string): Promise<FilingProviderKind> {
  const [firm, payer] = await Promise.all([
    db.query.firms.findFirst({ where: eq(firms.id, firmId) }),
    db.query.payers.findFirst({ where: eq(payers.id, payerId) }),
  ]);
  if (!firm || !payer) throw AppError.notFound('Payer');
  return (payer.filingProviderOverride ?? firm.filingProvider) as FilingProviderKind;
}

export interface Tax1099Config {
  apiKey: string;
  environment: 'sandbox' | 'production';
  mailing: boolean;
}

export async function loadTax1099Config(db: Db, firmId: string): Promise<Tax1099Config> {
  const firm = await db.query.firms.findFirst({ where: eq(firms.id, firmId) });
  if (!firm) throw AppError.notFound('Firm');
  if (!firm.tax1099ApiKeyEncrypted) {
    throw new AppError(ErrorCodes.E_IRIS_AUTH, 'Tax1099 is not configured — add your Tax1099 API key in Settings', 409);
  }
  // §7216 gate: no payee TIN leaves the appliance for Zenwork until an admin has
  // acknowledged the auxiliary-services disclosure (Treas. Reg. §301.7216-2(d)).
  if (!firm.tax1099DisclosureAckAt) {
    throw new AppError(
      ErrorCodes.E_IRIS_AUTH,
      'Tax1099 disclosure not acknowledged — an admin must accept the §7216 third-party disclosure in Settings before filing/mailing through Tax1099.',
      409,
    );
  }
  return {
    apiKey: getCrypto().decrypt(firm.tax1099ApiKeyEncrypted),
    environment: firm.tax1099Environment,
    mailing: firm.tax1099Mailing,
  };
}

/** True when the firm's default filing backend is Tax1099. */
export async function firmUsesTax1099(firmId: string): Promise<boolean> {
  const db = getDb();
  const firm = await db.query.firms.findFirst({ where: eq(firms.id, firmId) });
  return firm?.filingProvider === 'tax1099';
}

/** Build a Tax1099 REST client for API-side add-ons (TIN match, W-9, mailing). */
export async function buildTax1099Client(db: Db, firmId: string): Promise<Tax1099Client> {
  const cfg = await loadTax1099Config(db, firmId);
  const env = loadEnv();
  const base =
    env.TAX1099_MOCK_BASE_URL ||
    (cfg.environment === 'production' ? env.TAX1099_PROD_BASE_URL : env.TAX1099_SANDBOX_BASE_URL);
  return new Tax1099Client(tax1099Endpoints(base), { apiKey: cfg.apiKey });
}
