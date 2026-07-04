/**
 * Portal one-time-code (OTP) verification — a possession factor for the public
 * portals. A URL click-token proves you received the link; an OTP sent to the
 * recipient's/client's email or SMS on file proves you control that contact. When
 * enabled (setting `portal_otp_required`, default on) and a contact exists, the
 * portal is not viewable until the code is verified. Verification is bound to a
 * per-browser session id (cookie), so token possession alone can't ride it.
 *
 * Redis keys (short-lived): potp:<key> = {hash, attempts}; potp-ok:<key> = '1'.
 */
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { getQueue, getRedis, QUEUE_NAMES, type DeliveryJob } from '@vibe1099/core';
import { getSetting } from './settings.js';

const OTP_TTL = 600; // 10 min to enter the code
const VERIFIED_TTL = 1800; // 30 min viewing window after verifying
const MAX_ATTEMPTS = 5;
const RESEND_THROTTLE = 30; // seconds between sends

export type OtpChannel = 'email' | 'sms';

function codeHash(key: string, code: string): string {
  return createHash('sha256').update(`${key}:${code}`).digest('hex');
}

/** Whether portal OTP is required appliance-wide (admin setting, default on). */
export async function portalOtpRequired(): Promise<boolean> {
  return (await getSetting<boolean>('portal_otp_required')) !== false;
}

/** Generate + send a code to the contact, bound to `key`. Throttled per key. */
export async function requestPortalOtp(
  firmId: string,
  firmName: string,
  key: string,
  contact: { channel: OtpChannel; to: string },
): Promise<{ sent: boolean; throttled?: boolean }> {
  const redis = getRedis();
  if (await redis.get(`potp-sent:${key}`)) return { sent: false, throttled: true };
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await redis.set(`potp:${key}`, JSON.stringify({ hash: codeHash(key, code), attempts: 0 }), 'EX', OTP_TTL);
  await redis.set(`potp-sent:${key}`, '1', 'EX', RESEND_THROTTLE);
  const job: DeliveryJob = {
    kind: 'portal_code',
    channel: contact.channel,
    firmId,
    to: contact.to,
    templateKey: 'portal_code',
    vars: { code, firmName },
  };
  await getQueue(QUEUE_NAMES.delivery).add('portal_code', job);
  return { sent: true };
}

/** Verify a submitted code. On success, marks `key` verified for the viewing window. */
export async function verifyPortalOtp(key: string, code: string): Promise<'ok' | 'wrong' | 'expired' | 'locked'> {
  const redis = getRedis();
  const raw = await redis.get(`potp:${key}`);
  if (!raw) return 'expired';
  const state = JSON.parse(raw) as { hash: string; attempts: number };
  if (state.attempts >= MAX_ATTEMPTS) {
    await redis.del(`potp:${key}`);
    return 'locked';
  }
  const expected = Buffer.from(state.hash);
  const got = Buffer.from(codeHash(key, code));
  const match = expected.length === got.length && timingSafeEqual(expected, got);
  if (!match) {
    state.attempts += 1;
    const ttl = await redis.ttl(`potp:${key}`);
    await redis.set(`potp:${key}`, JSON.stringify(state), 'EX', ttl > 0 ? ttl : OTP_TTL);
    return state.attempts >= MAX_ATTEMPTS ? 'locked' : 'wrong';
  }
  await redis.del(`potp:${key}`);
  await redis.set(`potp-ok:${key}`, '1', 'EX', VERIFIED_TTL);
  return 'ok';
}

export async function isPortalOtpVerified(key: string): Promise<boolean> {
  return (await getRedis().get(`potp-ok:${key}`)) === '1';
}

/** Mask a contact for display: j***@x.com / •••-•••-1234. */
export function maskContact(channel: OtpChannel, to: string): string {
  if (channel === 'email') {
    const [u, d] = to.split('@');
    return `${(u ?? '').slice(0, 1)}***@${d ?? ''}`;
  }
  const digits = to.replace(/\D/g, '');
  return `•••-•••-${digits.slice(-4)}`;
}
