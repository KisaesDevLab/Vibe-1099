/**
 * Crypto service (Phase 3 / ADR-002).
 *
 * Envelope pattern: install MASTER_KEY (32B) → HKDF-derived purpose keys:
 *   - kek: wraps per-record DEKs (AES-256-GCM)
 *   - hmac: tin_hash = HMAC-SHA256(normalized TIN)  → lookup without decryption
 *   - token: HMAC signing key for portal/invite/W-9 tokens
 *
 * Ciphertext format (versioned): v1.<iv>.<ct>.<tag>.<wrappedDekIv>.<wrappedDek>.<wrappedDekTag>
 * All segments base64url. Plaintext TIN is never logged and never appears in URLs.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const b64u = {
  enc: (b: Buffer) => b.toString('base64url'),
  dec: (s: string) => Buffer.from(s, 'base64url'),
};

export class CryptoService {
  private readonly kek: Buffer;
  private readonly hmacKey: Buffer;
  private readonly tokenKey: Buffer;

  constructor(masterKeyBase64: string) {
    const master = Buffer.from(masterKeyBase64, 'base64');
    if (master.length !== 32) throw new Error('MASTER_KEY must be 32 bytes');
    this.kek = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'vibe1099:kek:v1', 32));
    this.hmacKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'vibe1099:tin-hmac:v1', 32));
    this.tokenKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'vibe1099:token:v1', 32));
  }

  /** Envelope-encrypt a UTF-8 string (TINs, JWKs, TOTP secrets). */
  encrypt(plaintext: string): string {
    return this.encryptBytes(Buffer.from(plaintext, 'utf8'));
  }

  encryptBytes(plaintext: Buffer): string {
    const dek = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const wrapIv = randomBytes(12);
    const wrap = createCipheriv('aes-256-gcm', this.kek, wrapIv);
    const wrappedDek = Buffer.concat([wrap.update(dek), wrap.final()]);
    const wrapTag = wrap.getAuthTag();

    return ['v1', b64u.enc(iv), b64u.enc(ct), b64u.enc(tag), b64u.enc(wrapIv), b64u.enc(wrappedDek), b64u.enc(wrapTag)].join('.');
  }

  decrypt(ciphertext: string): string {
    return this.decryptBytes(ciphertext).toString('utf8');
  }

  decryptBytes(ciphertext: string): Buffer {
    const parts = ciphertext.split('.');
    if (parts.length !== 7 || parts[0] !== 'v1') throw new Error('Unsupported ciphertext format');
    const [, ivS, ctS, tagS, wrapIvS, wrappedDekS, wrapTagS] = parts as [string, string, string, string, string, string, string];

    const unwrap = createDecipheriv('aes-256-gcm', this.kek, b64u.dec(wrapIvS));
    unwrap.setAuthTag(b64u.dec(wrapTagS));
    const dek = Buffer.concat([unwrap.update(b64u.dec(wrappedDekS)), unwrap.final()]);

    const decipher = createDecipheriv('aes-256-gcm', dek, b64u.dec(ivS));
    decipher.setAuthTag(b64u.dec(tagS));
    return Buffer.concat([decipher.update(b64u.dec(ctS)), decipher.final()]);
  }

  /**
   * tin_hash — deterministic keyed HMAC for encrypted-TIN lookup (ADR-002).
   * Domain-separated by firmId + tinType so the same 9 digits produce different
   * hashes across firms (no cross-tenant correlation from a DB dump) and an
   * SSN cannot collide with an identical-digit EIN.
   */
  tinHash(normalizedTin: string, firmId: string, tinType: string): string {
    return createHmac('sha256', this.hmacKey).update(`${firmId}:${tinType}:${normalizedTin}`).digest('hex');
  }

  /** Opaque one-way hash for stored tokens (invites, W-9, portal, resets). */
  tokenHash(token: string): string {
    return createHmac('sha256', this.tokenKey).update(token).digest('hex');
  }

  /** Random URL-safe token (no PII in URLs — short opaque ids). */
  newToken(bytes = 24): string {
    return randomBytes(bytes).toString('base64url');
  }

  /**
   * HMAC-signed expiring token (T&B third-party-share pattern):
   * payload = <scope>.<id>.<expEpochSec>, token = payload.sig
   * Verified stateless; revocation via DB token_hash column.
   */
  signScopedToken(scope: string, id: string, expiresAt: Date): string {
    // include a random nonce so every issued token (and its stored token_hash) is
    // unique — a revoke+reissue at the same expiry second yields a NEW token, so a
    // leaked link genuinely stops working after reissue
    const nonce = randomBytes(9).toString('base64url');
    const payload = `${scope}.${id}.${Math.floor(expiresAt.getTime() / 1000)}.${nonce}`;
    const sig = createHmac('sha256', this.tokenKey).update(payload).digest('base64url');
    return `${Buffer.from(payload, 'utf8').toString('base64url')}.${sig}`;
  }

  verifyScopedToken(token: string, expectedScope: string): { id: string; expiresAt: Date } | null {
    const dot = token.lastIndexOf('.');
    if (dot < 0) return null;
    const payloadB64 = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    let payload: string;
    try {
      payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
    } catch {
      return null;
    }
    const expect = createHmac('sha256', this.tokenKey).update(payload).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const parts = payload.split('.');
    if (parts.length < 3) return null; // scope.id.exp[.nonce]
    const [scope, id, expS] = parts as [string, string, string];
    if (scope !== expectedScope) return null;
    const exp = parseInt(expS, 10);
    if (!Number.isFinite(exp)) return null;
    const expiresAt = new Date(exp * 1000);
    if (expiresAt.getTime() < Date.now()) return null;
    return { id, expiresAt };
  }
}

/** Constant-time equality for equal-length hex digests (token_hash comparisons). */
export function safeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

let instance: CryptoService | undefined;
export function getCrypto(masterKeyBase64?: string): CryptoService {
  if (!instance) {
    const key = masterKeyBase64 ?? process.env.MASTER_KEY;
    if (!key) throw new Error('MASTER_KEY not set');
    instance = new CryptoService(key);
  }
  return instance;
}
export function resetCrypto(): void {
  instance = undefined;
}
