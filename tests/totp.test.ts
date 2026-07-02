import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateTotpSecret, totpCode, verifyTotp } from '../apps/api/src/services/totp.js';

describe('TOTP (RFC 6238)', () => {
  it('base32 round-trip', () => {
    const secret = generateTotpSecret();
    expect(base32Encode(base32Decode(secret))).toBe(secret);
  });

  it('RFC 6238 SHA-1 test vector (T=59s, 8→6 digit truncation of 94287082)', () => {
    // seed "12345678901234567890" base32 = GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
    const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(totpCode(seed, 30_000, 59_000)).toBe('287082');
  });

  it('verify accepts ±1 window, rejects garbage', () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    expect(verifyTotp(secret, totpCode(secret, 30_000, now))).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, 30_000, now - 30_000))).toBe(true);
    expect(verifyTotp(secret, '000000')).toBe(verifyTotp(secret, '000000')); // deterministic
    expect(verifyTotp(secret, totpCode(secret, 30_000, now - 300_000))).toBe(false);
  });
});
