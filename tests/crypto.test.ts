import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { CryptoService } from '@vibe1099/core/crypto';

const key = () => randomBytes(32).toString('base64');

describe('CryptoService — envelope AES-256-GCM + HMAC tin_hash (ADR-002)', () => {
  it('encryption round-trip', () => {
    const svc = new CryptoService(key());
    const ct = svc.encrypt('400111222');
    expect(ct.startsWith('v1.')).toBe(true);
    expect(ct).not.toContain('400111222');
    expect(svc.decrypt(ct)).toBe('400111222');
  });

  it('unique DEK per record: same plaintext → different ciphertext', () => {
    const svc = new CryptoService(key());
    expect(svc.encrypt('400111222')).not.toBe(svc.encrypt('400111222'));
  });

  it('wrong master key cannot decrypt', () => {
    const a = new CryptoService(key());
    const b = new CryptoService(key());
    const ct = a.encrypt('secret');
    expect(() => b.decrypt(ct)).toThrow();
  });

  it('tamper detection (GCM auth)', () => {
    const svc = new CryptoService(key());
    const ct = svc.encrypt('secret');
    const parts = ct.split('.');
    parts[2] = parts[2]!.slice(0, -2) + 'AA';
    expect(() => svc.decrypt(parts.join('.'))).toThrow();
  });

  it('tin_hash is deterministic per install, differs across installs', () => {
    const k1 = key();
    const a = new CryptoService(k1);
    const b = new CryptoService(k1);
    const c = new CryptoService(key());
    expect(a.tinHash('400111222', 'firm1', 'SSN')).toBe(b.tinHash('400111222', 'firm1', 'SSN'));
    expect(a.tinHash('400111222', 'firm1', 'SSN')).not.toBe(c.tinHash('400111222', 'firm1', 'SSN'));
    expect(a.tinHash('400111222', 'firm1', 'SSN')).not.toBe(a.tinHash('400111223', 'firm1', 'SSN'));
  });

  it('tin_hash is domain-separated by firm and TIN type (no cross-tenant correlation / SSN-EIN collision)', () => {
    const a = new CryptoService(key());
    // same digits, different firm → different hash
    expect(a.tinHash('400111222', 'firmA', 'SSN')).not.toBe(a.tinHash('400111222', 'firmB', 'SSN'));
    // same digits, different type → different hash
    expect(a.tinHash('123456789', 'firmA', 'SSN')).not.toBe(a.tinHash('123456789', 'firmA', 'EIN'));
  });

  it('scoped tokens verify, expire, and reject cross-scope', () => {
    const svc = new CryptoService(key());
    const future = new Date(Date.now() + 60_000);
    const token = svc.signScopedToken('recipient', 'abc-123', future);
    expect(svc.verifyScopedToken(token, 'recipient')?.id).toBe('abc-123');
    expect(svc.verifyScopedToken(token, 'client')).toBeNull(); // wrong scope
    const expired = svc.signScopedToken('recipient', 'abc-123', new Date(Date.now() - 1000));
    expect(svc.verifyScopedToken(expired, 'recipient')).toBeNull();
    expect(svc.verifyScopedToken(token + 'x', 'recipient')).toBeNull(); // tamper
  });

  it('scoped tokens carry a nonce: reissue at the same expiry second yields a different token', () => {
    const svc = new CryptoService(key());
    const exp = new Date(Date.now() + 60_000);
    const t1 = svc.signScopedToken('recipient', 'abc-123', exp);
    const t2 = svc.signScopedToken('recipient', 'abc-123', exp);
    expect(t1).not.toBe(t2); // nonce makes each issuance unique (revoke+reissue actually rotates)
    expect(svc.verifyScopedToken(t1, 'recipient')?.id).toBe('abc-123');
    expect(svc.verifyScopedToken(t2, 'recipient')?.id).toBe('abc-123');
  });

  it('binary round-trip (encrypted blobs)', () => {
    const svc = new CryptoService(key());
    const data = randomBytes(1024);
    expect(svc.decryptBytes(svc.encryptBytes(data)).equals(data)).toBe(true);
  });
});
