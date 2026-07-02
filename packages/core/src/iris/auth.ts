/**
 * IRIS A2A OAuth (Pub 5718): JWT assertion signed with the firm's registered
 * private JWK → bearer access token. Token cached with early refresh.
 */
import { createPrivateKey, createSign, randomUUID, type KeyObject } from 'node:crypto';

export interface IrisCredentials {
  apiClientId: string;
  privateJwk: Record<string, unknown>; // decrypted from firms.iris_jwk_encrypted
  tokenUrl: string; // e.g. `${base}/auth/oauth/v2/token`
}

function b64uJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

export function buildJwtAssertion(creds: IrisCredentials, now = new Date()): string {
  const key: KeyObject = createPrivateKey({ key: creds.privateJwk as never, format: 'jwk' });
  const isEc = key.asymmetricKeyType === 'ec';
  const header = { alg: isEc ? 'ES256' : 'RS256', typ: 'JWT', kid: (creds.privateJwk['kid'] as string) ?? undefined };
  const iat = Math.floor(now.getTime() / 1000);
  const payload = {
    iss: creds.apiClientId,
    sub: creds.apiClientId,
    aud: creds.tokenUrl,
    jti: randomUUID(),
    iat,
    exp: iat + 15 * 60,
  };
  const signingInput = `${b64uJson(header)}.${b64uJson(payload)}`;
  const signer = createSign('SHA256');
  signer.update(signingInput);
  const sig = isEc
    ? signer.sign({ key, dsaEncoding: 'ieee-p1363' })
    : signer.sign(key);
  return `${signingInput}.${sig.toString('base64url')}`;
}

export interface AccessToken {
  token: string;
  expiresAt: number; // epoch ms
}

const tokenCache = new Map<string, AccessToken>();

export async function getAccessToken(creds: IrisCredentials, fetchImpl: typeof fetch = fetch): Promise<string> {
  const cacheKey = `${creds.tokenUrl}:${creds.apiClientId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

  const assertion = buildJwtAssertion(creds);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion,
  });
  const res = await fetchImpl(creds.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`IRIS token endpoint ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in?: number };
  const token: AccessToken = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  tokenCache.set(cacheKey, token);
  return token.token;
}

export function clearTokenCache(): void {
  tokenCache.clear();
}

/** Generate an RSA keypair as JWK for IRS enrollment (Settings → JWK tooling). */
export async function generateJwkPair(): Promise<{ privateJwk: Record<string, unknown>; publicJwk: Record<string, unknown> }> {
  const { generateKeyPairSync, randomUUID: uuid } = await import('node:crypto');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = uuid();
  const privateJwk = { ...(privateKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, use: 'sig', alg: 'RS256' };
  const publicJwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, use: 'sig', alg: 'RS256' };
  return { privateJwk, publicJwk };
}
