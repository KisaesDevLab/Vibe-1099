/**
 * Client self-service sign-in — for a client who reaches /client without their
 * invite link. They enter the email or mobile their accountant has on file; if it
 * matches an engagement, a one-time code goes to THAT contact, and verifying
 * it mints a short-lived browser session scoped to the matched invites only.
 * The session carries exactly the client-zone scope a magic link does (payer +
 * tax year) — proving control of the mailbox/phone the link was sent to.
 *
 * Invite EXPIRY does not apply here — it bounds how long an emailed link stays
 * live, while a fresh code re-proves the contact every time (so a client can
 * still get in after the season to print filed 1099s). Revoking the invite is
 * what shuts code sign-in off.
 *
 * Nothing here reveals whether a contact matched: the request always "succeeds"
 * and a failed verify is one generic error.
 *
 * Redis keys: clogin:<sid> = pending contact; clogin-cap:<digest> = per-contact
 * send cap; csess:<sid> = { invites: { <inviteId>: otpSatisfied } }.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getCrypto, getRedis, toE164 } from '@vibe1099/core';
import { clientInvites, firms, getDb, payers } from '@vibe1099/db';
import { requestPortalOtp, verifyPortalOtp, type OtpChannel } from './portal-otp.js';

/** Bearer value the portal sends for a signed-in engagement: `session:<inviteId>`.
 *  Signed link tokens are base64url + '.', so the ':' can never collide. */
export const CLIENT_SESSION_PREFIX = 'session:';
export const CLIENT_SESSION_TTL = 2 * 60 * 60; // seconds
const PENDING_TTL = 600; // matches the code's lifetime
const SENDS_PER_CONTACT_PER_HOUR = 5;

/** `value` is normalized: lower-cased email, or E.164 mobile. */
export interface LoginContact {
  channel: OtpChannel;
  value: string;
}

export interface InviteContactRow {
  inviteId: string;
  firmId: string;
  payerId: string;
  taxYear: number;
  createdAt: Date;
  inviteEmail: string | null;
  inviteMobile: string | null;
  payerEmail: string | null;
  payerMobile: string | null;
}

export interface EngagementMatch {
  inviteId: string;
  firmId: string;
}

export function normalizeLoginContact(raw: string): LoginContact | null {
  const s = raw.trim();
  if (s.includes('@')) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? { channel: 'email', value: s.toLowerCase() } : null;
  }
  try {
    return { channel: 'sms', value: toE164(s) };
  } catch {
    return null;
  }
}

/**
 * Every contact an engagement's codes may go to — the payer's contact on file and
 * the destination staff typed on the invite — normalized and de-duplicated, email
 * first. Sign-in matching and the portal's own verification step share this list,
 * so a code is always deliverable to the same place the client was reached.
 */
export function engagementContacts(c: Pick<InviteContactRow, 'inviteEmail' | 'inviteMobile' | 'payerEmail' | 'payerMobile'>): LoginContact[] {
  const out: LoginContact[] = [];
  const add = (channel: OtpChannel, raw: string | null) => {
    const n = raw ? normalizeLoginContact(raw) : null;
    if (n && n.channel === channel && !out.some((o) => o.value === n.value)) out.push(n);
  };
  add('email', c.payerEmail);
  add('email', c.inviteEmail);
  add('sms', c.payerMobile);
  add('sms', c.inviteMobile);
  return out;
}

/**
 * Invites this contact may sign in to: the invite's own email/mobile or the
 * payer's contact on file. Newest invite wins per (payer, tax year).
 */
export function matchEngagements(contact: LoginContact, rows: InviteContactRow[]): EngagementMatch[] {
  const newest = new Map<string, InviteContactRow>();
  for (const r of rows) {
    if (!engagementContacts(r).some((c) => c.channel === contact.channel && c.value === contact.value)) continue;
    const key = `${r.payerId}:${r.taxYear}`;
    const prev = newest.get(key);
    if (!prev || r.createdAt.getTime() > prev.createdAt.getTime()) newest.set(key, r);
  }
  return [...newest.values()].map((r) => ({ inviteId: r.inviteId, firmId: r.firmId }));
}

// Contacts are stored free-form (phone punctuation, email case), so matching is
// done in JS over the un-revoked invites — small at appliance scale.
async function loadLiveInvites(): Promise<InviteContactRow[]> {
  return getDb()
    .select({
      inviteId: clientInvites.id,
      firmId: clientInvites.firmId,
      payerId: clientInvites.payerId,
      taxYear: clientInvites.taxYear,
      createdAt: clientInvites.createdAt,
      inviteEmail: clientInvites.email,
      inviteMobile: clientInvites.mobile,
      payerEmail: payers.contactEmail,
      payerMobile: payers.contactMobile,
    })
    .from(clientInvites)
    .innerJoin(payers, eq(payers.id, clientInvites.payerId))
    .where(isNull(clientInvites.revokedAt));
}

const contactDigest = (c: LoginContact) => createHash('sha256').update(`${c.channel}:${c.value}`).digest('hex');
const otpKey = (sid: string, c: LoginContact) => `client-login:${sid}:${contactDigest(c)}`;

/** Send a sign-in code if (and only if) the contact matches an un-revoked invite. */
export async function requestClientLogin(sid: string, contact: LoginContact): Promise<void> {
  const redis = getRedis();
  await redis.set(`clogin:${sid}`, JSON.stringify(contact), 'EX', PENDING_TTL);
  const matches = matchEngagements(contact, await loadLiveInvites());
  if (!matches.length) return;
  // Per-contact cap: the per-browser resend throttle is keyed by cookie, which an
  // attacker can rotate to flood a client's inbox/phone (and run up SMS cost).
  const capKey = `clogin-cap:${contactDigest(contact)}`;
  const sends = await redis.incr(capKey);
  if (sends === 1) await redis.expire(capKey, 3600);
  if (sends > SENDS_PER_CONTACT_PER_HOUR) return;
  const firmId = matches[0]!.firmId;
  const firm = await getDb().query.firms.findFirst({ where: eq(firms.id, firmId) });
  await requestPortalOtp(firmId, firm?.name ?? 'your accountant', otpKey(sid, contact), { channel: contact.channel, to: contact.value });
}

/**
 * Verify the code for the pending sign-in bound to `sid`. On success mints a NEW
 * session id (never promote the pre-login cookie) and returns it with its matches.
 */
export async function verifyClientLogin(sid: string, code: string): Promise<{ sid: string; matches: EngagementMatch[]; channel: OtpChannel } | null> {
  const redis = getRedis();
  const raw = await redis.get(`clogin:${sid}`);
  if (!raw) return null;
  const contact = JSON.parse(raw) as LoginContact;
  if ((await verifyPortalOtp(otpKey(sid, contact), code)) !== 'ok') return null;
  await redis.del(`clogin:${sid}`);
  const matches = matchEngagements(contact, await loadLiveInvites());
  if (!matches.length) return null;
  const newSid = getCrypto().newToken(32);
  // true = the sign-in code already verified one of the engagement's contacts,
  // which is all the portal's own verification step would ask for
  const invites = Object.fromEntries(matches.map((m) => [m.inviteId, true]));
  await redis.set(`csess:${newSid}`, JSON.stringify({ invites }), 'EX', CLIENT_SESSION_TTL);
  return { sid: newSid, matches, channel: contact.channel };
}

/** inviteId → otpSatisfied for the signed-in browser, or null when not signed in. */
export async function readClientSession(sid: string): Promise<Record<string, boolean> | null> {
  const raw = await getRedis().get(`csess:${sid}`);
  return raw ? (JSON.parse(raw) as { invites: Record<string, boolean> }).invites : null;
}

/** The engagements a signed-in client can open (drops any since revoked). */
export async function listClientEngagements(inviteIds: string[]) {
  if (!inviteIds.length) return [];
  const rows = await getDb()
    .select({
      inviteId: clientInvites.id,
      firmName: firms.name,
      payerName: payers.legalName,
      taxYear: clientInvites.taxYear,
      submittedAt: clientInvites.submittedAt,
    })
    .from(clientInvites)
    .innerJoin(payers, eq(payers.id, clientInvites.payerId))
    .innerJoin(firms, eq(firms.id, clientInvites.firmId))
    .where(and(inArray(clientInvites.id, inviteIds), isNull(clientInvites.revokedAt)));
  return rows
    .map((r) => ({ inviteId: r.inviteId, firmName: r.firmName, payerName: r.payerName, taxYear: r.taxYear, submitted: !!r.submittedAt }))
    .sort((a, b) => b.taxYear - a.taxYear || a.payerName.localeCompare(b.payerName));
}
