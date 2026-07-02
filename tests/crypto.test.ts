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
    expect(a.tinHash('400111222')).toBe(b.tinHash('400111222'));
    expect(a.tinHash('400111222')).not.toBe(c.tinHash('400111222'));
    expect(a.tinHash('400111222')).not.toBe(a.tinHash('400111223'));
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

  it('binary round-trip (encrypted blobs)', () => {
    const svc = new CryptoService(key());
    const data = randomBytes(1024);
    expect(svc.decryptBytes(svc.encryptBytes(data)).equals(data)).toBe(true);
  });
});
