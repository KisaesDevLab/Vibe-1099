/**
 * RFC 6238 TOTP (optional staff 2FA) — no external deps.
 */
import { createHmac, randomBytes } from 'node:crypto';

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secretB32: string, timeStepMs = 30_000, at = Date.now()): string {
  const counter = Math.floor(at / timeStepMs);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const offset = (hmac[hmac.length - 1] as number) & 0x0f;
  const code =
    (((hmac[offset] as number) & 0x7f) << 24) |
    ((hmac[offset + 1] as number) << 16) |
    ((hmac[offset + 2] as number) << 8) |
    (hmac[offset + 3] as number);
  return String(code % 1_000_000).padStart(6, '0');
}

export function verifyTotp(secretB32: string, code: string, windowSteps = 1): boolean {
  const now = Date.now();
  for (let i = -windowSteps; i <= windowSteps; i++) {
    if (totpCode(secretB32, 30_000, now + i * 30_000) === code) return true;
  }
  return false;
}

export function otpauthUrl(secretB32: string, account: string, issuer = 'Vibe 1099'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}`;
}
