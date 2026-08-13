/**
 * Filing-provider resolution + config (Tax1099 Phase 1).
 *
 * Provider is chosen per-payer, falling back to the firm default. IRIS config
 * (TCC/JWK) is only required for IRIS payers; Tax1099 payers need only the
 * firm's Tax1099 app key — so an entity can e-file with NO IRS TCC of its own.
 */
import { and, desc, eq } from 'drizzle-orm';
import { AppError, ErrorCodes } from '@vibe1099/shared';
import {
  getCrypto,
  loadEnv,
  Tax1099Client,
  tax1099Endpoints,
  TaxBanditsClient,
  taxbanditsEndpoints,
  type FilingProviderKind,
} from '@vibe1099/core';
import { firms, formRecords, payers, transmissions, getDb, type Db } from '@vibe1099/db';

export async function resolveProviderKind(db: Db, firmId: string, payerId: string): Promise<FilingProviderKind> {
  const [firm, payer] = await Promise.all([
    db.query.firms.findFirst({ where: eq(firms.id, firmId) }),
    db.query.payers.findFirst({ where: eq(payers.id, payerId) }),
  ]);
  if (!firm || !payer) throw AppError.notFound('Payer');
  return (payer.filingProviderOverride ?? firm.filingProvider) as FilingProviderKind;
}

/**
 * Corrections affinity (addendum §2.3, hard invariant): a correction/void MUST
 * transmit through the SAME provider as the original filing. Given the correction
 * records queued for a batch, resolve the provider from the original transmission
 * they descend from (via correctsId → original record → its transmission). Throws
 * if the queued corrections descend from more than one provider.
 */
export async function resolveCorrectionProvider(
  db: Db,
  firmId: string,
  correctionRecordIds: string[],
): Promise<FilingProviderKind | null> {
  const providers = new Set<FilingProviderKind>();
  for (const id of correctionRecordIds) {
    const rec = await db.query.formRecords.findFirst({ where: and(eq(formRecords.id, id), eq(formRecords.firmId, firmId)) });
    if (!rec?.correctsId) continue;
    // walk to the head original, then find the transmission that filed it
    let originalId: string | null = rec.correctsId;
    let guard = 0;
    let original = await db.query.formRecords.findFirst({ where: eq(formRecords.id, originalId) });
    while (original?.correctsId && guard++ < 10) {
      originalId = original.correctsId;
      original = await db.query.formRecords.findFirst({ where: eq(formRecords.id, originalId) });
    }
    if (!original) continue;
    const tx = original.transmissionId
      ? await db.query.transmissions.findFirst({ where: eq(transmissions.id, original.transmissionId) })
      : await db.query.transmissions.findFirst({
          where: and(eq(transmissions.firmId, firmId), eq(transmissions.taxYear, original.taxYear)),
          orderBy: desc(transmissions.createdAt),
        });
    if (tx) providers.add(tx.provider as FilingProviderKind);
  }
  if (providers.size > 1) {
    throw AppError.conflict('These corrections descend from filings on different providers — file them in separate batches (corrections stay on the original provider).');
  }
  return providers.size === 1 ? [...providers][0]! : null;
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

export interface TaxBanditsConfig {
  clientId: string;
  clientSecret: string;
  userToken: string;
  environment: 'sandbox' | 'production';
  postalMailing: boolean;
  onlineAccess: boolean;
}

export async function loadTaxBanditsConfig(db: Db, firmId: string): Promise<TaxBanditsConfig> {
  const firm = await db.query.firms.findFirst({ where: eq(firms.id, firmId) });
  if (!firm) throw AppError.notFound('Firm');
  if (!firm.taxbanditsEnabled || !firm.taxbanditsClientIdEncrypted || !firm.taxbanditsClientSecretEncrypted || !firm.taxbanditsUserTokenEncrypted) {
    throw new AppError(ErrorCodes.E_IRIS_AUTH, 'TaxBandits is not configured for this firm — add credentials in Settings', 409);
  }
  // §7216 gate: no payee TIN leaves the appliance for TaxBandits until an admin has
  // acknowledged the auxiliary-services disclosure (Treas. Reg. §301.7216-2(d)).
  if (!firm.taxbanditsDisclosureAckAt) {
    throw new AppError(
      ErrorCodes.E_IRIS_AUTH,
      'TaxBandits disclosure not acknowledged — an admin must accept the §7216 third-party disclosure in Settings before filing through TaxBandits.',
      409,
    );
  }
  const crypto = getCrypto();
  return {
    clientId: crypto.decrypt(firm.taxbanditsClientIdEncrypted),
    clientSecret: crypto.decrypt(firm.taxbanditsClientSecretEncrypted),
    userToken: crypto.decrypt(firm.taxbanditsUserTokenEncrypted),
    environment: firm.taxbanditsEnvironment,
    postalMailing: firm.taxbanditsPostalMailing,
    onlineAccess: firm.taxbanditsOnlineAccess,
  };
}

/** Build a TaxBandits REST client (TIN match, credits, corrections). */
export async function buildTaxBanditsClient(db: Db, firmId: string): Promise<TaxBanditsClient> {
  const cfg = await loadTaxBanditsConfig(db, firmId);
  const env = loadEnv();
  const mock = env.TAXBANDITS_MOCK_BASE_URL;
  const base = mock || (cfg.environment === 'production' ? env.TAXBANDITS_PROD_BASE_URL : env.TAXBANDITS_SANDBOX_BASE_URL);
  const oauthUrl = mock
    ? `${mock.replace(/\/$/, '')}/v2/tbsauth`
    : cfg.environment === 'production'
      ? env.TAXBANDITS_PROD_OAUTH_URL
      : env.TAXBANDITS_SANDBOX_OAUTH_URL;
  return new TaxBanditsClient(taxbanditsEndpoints(base, oauthUrl), {
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    userToken: cfg.userToken,
  });
}
