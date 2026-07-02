import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateTotpSecret, totpCode, verifyTotp, verifyTotpCounter } from '../apps/api/src/services/totp.js';

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
    expect(verifyTotp(secret, totpCode(secret, 30_000, now - 300_000))).toBe(false);
  });

  it('verifyTotpCounter returns the matched counter and rejects the future step by default', () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const cur = Math.floor(now / 30_000);
    // current and previous step accepted; the returned counter identifies the code for replay tracking
    expect(verifyTotpCounter(secret, totpCode(secret, 30_000, now), 1, 0, now)).toBe(cur);
    expect(verifyTotpCounter(secret, totpCode(secret, 30_000, now - 30_000), 1, 0, now)).toBe(cur - 1);
    // a future-step code is NOT accepted when fwdSteps = 0 (shrinks guess surface)
    expect(verifyTotpCounter(secret, totpCode(secret, 30_000, now + 30_000), 1, 0, now)).toBeNull();
    // same code maps to the same counter twice — the caller uses this to reject replay
    const code = totpCode(secret, 30_000, now);
    expect(verifyTotpCounter(secret, code, 1, 0, now)).toBe(verifyTotpCounter(secret, code, 1, 0, now));
  });
});
