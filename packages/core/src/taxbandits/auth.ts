/**
 * TaxBandits (SPAN Enterprises) OAuth 2.0 auth.
 *
 * TaxBandits issues a short-lived JWT access token in exchange for a JWS-signed
 * assertion built from the developer ClientId/ClientSecret and the per-account
 * UserToken. We sign the assertion locally (HS256 over the ClientSecret) and cache
 * the returned access token until shortly before expiry, with single-flight
 * refresh so a burst of filings doesn't stampede the token endpoint.
 *
 * The exact assertion header/claim names follow the TaxBandits Developer Console
 * contract; they are centralized here so a live wire-up is a localized change.
 */
import { createHmac } from 'node:crypto';
import { AppError, ErrorCodes } from '@vibe1099/shared';

export interface TaxBanditsCredentials {
  clientId: string;
  clientSecret: string;
  userToken: string;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Build a short-lived JWS assertion (HS256) for the token exchange. */
export function buildAssertion(creds: TaxBanditsCredentials, now: number): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const iat = Math.floor(now / 1000);
  const claims = {
    iss: creds.clientId,
    sub: creds.clientId,
    aud: creds.userToken,
    iat,
    exp: iat + 300, // 5-minute assertion
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = b64url(createHmac('sha256', creds.clientSecret).update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class TaxBanditsAuth {
  private cached: CachedToken | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly tokenUrl: string,
    private readonly creds: TaxBanditsCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Return a valid access token, refreshing (single-flight) when near expiry. */
  async accessToken(): Promise<string> {
    const t = this.now();
    if (this.cached && this.cached.expiresAt - 30_000 > t) return this.cached.token;
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(): Promise<string> {
    const assertion = buildAssertion(this.creds, this.now());
    let res: Response;
    try {
      res = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: assertion },
        body: JSON.stringify({ grant_type: 'client_credentials' }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new AppError(ErrorCodes.E_IRIS, `TaxBandits auth request failed: ${(err as Error).message}`, 502);
    }
    const raw = await res.text();
    if (!res.ok) throw new AppError(ErrorCodes.E_IRIS_AUTH, `TaxBandits auth rejected (${res.status})`, 502, { raw });
    const body = JSON.parse(raw) as { AccessToken?: string; access_token?: string; ExpiresIn?: number; expires_in?: number };
    const token = body.AccessToken ?? body.access_token;
    if (!token) throw new AppError(ErrorCodes.E_IRIS_AUTH, 'TaxBandits auth response missing access token', 502, { raw });
    const ttlSec = body.ExpiresIn ?? body.expires_in ?? 3600;
    this.cached = { token, expiresAt: this.now() + ttlSec * 1000 };
    return token;
  }
}
