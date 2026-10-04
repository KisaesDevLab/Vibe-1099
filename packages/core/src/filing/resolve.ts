/**
 * Filing-provider construction — the SINGLE implementation used by both the API
 * (TIN match, status check, W-9 add-ons) and the worker (transmit / poll).
 *
 * Each builder decrypts the firm's credentials, applies the §7216 disclosure
 * gate (no payee TIN leaves the appliance for a third party until an admin has
 * acknowledged the auxiliary-services disclosure, Treas. Reg. §301.7216-2(d)),
 * and resolves the mock / sandbox / production base URL. Keeping one copy means
 * the compliance gate can never drift between the process that files and the
 * process that previews.
 */
import { eq } from 'drizzle-orm';
import { AppError, ErrorCodes } from '@vibe1099/shared';
import { firms, type Db } from '@vibe1099/db';
import { getCrypto } from '../crypto.js';
import { loadEnv } from '../env.js';
import { IrisClient, irisEndpoints } from '../iris/client.js';
import { Tax1099Client, tax1099Endpoints } from '../tax1099/client.js';
import { TaxBanditsClient, taxbanditsEndpoints } from '../taxbandits/client.js';
import { IrisFilingProvider } from './iris-provider.js';
import type { FilingProvider, FilingProviderKind } from './provider.js';

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

/** Build a Tax1099 REST client (filing, TIN match, W-9, mailing). */
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

/** Build a TaxBandits REST client (filing, TIN match, credits, corrections). */
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

/** Build the firm's own IRIS A2A transmitter (needs the firm's TCC + JWK). */
export async function buildIrisProvider(db: Db, firmId: string): Promise<IrisFilingProvider> {
  const firm = await db.query.firms.findFirst({ where: eq(firms.id, firmId) });
  if (!firm) throw AppError.notFound('Firm');
  if (!firm.irisJwkEncrypted || !firm.irisApiClientId) {
    throw new AppError(ErrorCodes.E_IRIS_AUTH, 'IRIS is not configured — enter TCC, API Client ID, and JWK in Settings', 409);
  }
  const env = loadEnv();
  const base = env.IRIS_MOCK_BASE_URL || (firm.irisEnvironment === 'PROD' ? env.IRIS_PROD_BASE_URL : env.IRIS_ATS_BASE_URL);
  return new IrisFilingProvider(
    new IrisClient(irisEndpoints(base), {
      apiClientId: firm.irisApiClientId,
      privateJwk: JSON.parse(getCrypto().decrypt(firm.irisJwkEncrypted)) as Record<string, unknown>,
      tokenUrl: irisEndpoints(base).tokenUrl,
    }),
  );
}

/** The FilingProvider a transmission targets, by its recorded provider kind. */
export async function buildFilingProvider(db: Db, firmId: string, kind: FilingProviderKind): Promise<FilingProvider> {
  if (kind === 'tax1099') return buildTax1099Client(db, firmId);
  if (kind === 'taxbandits') return buildTaxBanditsClient(db, firmId);
  return buildIrisProvider(db, firmId);
}
