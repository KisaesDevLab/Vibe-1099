/**
 * Trust-zone middleware (Phase 2):
 *  - staff: Redis session (sid cookie) + CSRF double-submit + inactivity timeout + roles
 *  - client: magic-link scoped token → invite row (payer + tax year scope only)
 *  - recipient: HMAC-signed expiring token + last-4 TIN challenge (challenge in routes)
 */
import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { AppError, ErrorCodes, type UserRole } from '@vibe1099/shared';
import { getCrypto, getRedis, loadEnv } from '@vibe1099/core';
import { clientInvites, deliveries, getDb } from '@vibe1099/db';
import type { StaffSession } from '../types.js';

export const SESSION_COOKIE = 'v1099_sid';
export const CSRF_COOKIE = 'v1099_csrf';

const SESSION_PREFIX = 'sess:';

export async function createSession(session: StaffSession): Promise<string> {
  const sid = getCrypto().newToken(32);
  await saveSession(sid, session);
  return sid;
}

async function saveSession(sid: string, session: StaffSession): Promise<void> {
  const env = loadEnv();
  await getRedis().set(`${SESSION_PREFIX}${sid}`, JSON.stringify(session), 'EX', env.SESSION_INACTIVITY_MINUTES * 60);
}

export async function destroySession(sid: string): Promise<void> {
  await getRedis().del(`${SESSION_PREFIX}${sid}`);
}

export async function destroyAllUserSessions(userId: string): Promise<void> {
  // sessions are short-lived (inactivity TTL); brute scan acceptable at appliance scale
  const redis = getRedis();
  const keys = await redis.keys(`${SESSION_PREFIX}*`);
  for (const key of keys) {
    const raw = await redis.get(key);
    if (raw && (JSON.parse(raw) as StaffSession).userId === userId) await redis.del(key);
  }
}

/** Staff zone: session + rolling inactivity timeout (Safeguards Rule alignment). */
export function requireStaff(...roles: UserRole[]) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const sid = (req.cookies as Record<string, string>)[SESSION_COOKIE];
      if (!sid) throw AppError.auth();
      const raw = await getRedis().get(`${SESSION_PREFIX}${sid}`);
      if (!raw) throw new AppError(ErrorCodes.E_TOKEN_EXPIRED, 'Session expired — sign in again', 401);
      const session = JSON.parse(raw) as StaffSession;

      // CSRF double-submit on mutations
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const cookieToken = (req.cookies as Record<string, string>)[CSRF_COOKIE];
        const headerToken = req.headers['x-csrf-token'];
        if (!cookieToken || cookieToken !== headerToken) {
          throw new AppError(ErrorCodes.E_CSRF, 'CSRF token missing or mismatched', 403);
        }
      }

      if (roles.length && !roles.includes(session.role)) {
        throw AppError.forbidden(`Requires role: ${roles.join(' or ')}`);
      }

      session.lastSeenAt = Date.now();
      await saveSession(sid, session); // rolling TTL refresh
      req.staff = session;
      req.sessionId = sid;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Staff-zone IP allowlist (config; CIDR-less exact/prefix match for appliance LAN use). */
export function staffIpAllowlist() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const env = loadEnv();
    if (!env.STAFF_IP_ALLOWLIST) return next();
    const allowed = env.STAFF_IP_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean);
    const ip = req.ip ?? '';
    const ok = allowed.some((a) => ip === a || ip.startsWith(a));
    if (!ok) return next(AppError.forbidden('Staff access is restricted from this network'));
    next();
  };
}

/** Client zone: bearer token from magic link → invite scope (payer + tax year ONLY). */
export function requireClient() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const auth = req.headers.authorization;
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : (req.query['token'] as string | undefined);
      if (!token) throw AppError.auth('Invite link token required');
      const crypto = getCrypto();
      const verified = crypto.verifyScopedToken(token, 'client');
      if (!verified) throw new AppError(ErrorCodes.E_TOKEN_EXPIRED, 'This link has expired or is invalid', 401);

      const db = getDb();
      const invite = await db.query.clientInvites.findFirst({ where: eq(clientInvites.id, verified.id) });
      if (!invite) throw AppError.auth('Invite not found');
      if (invite.revokedAt) throw new AppError(ErrorCodes.E_TOKEN_REVOKED, 'This link has been revoked', 401);
      if (invite.expiresAt.getTime() < Date.now()) {
        throw new AppError(ErrorCodes.E_TOKEN_EXPIRED, 'This link has expired — ask your accountant to reissue it', 401);
      }
      if (crypto.tokenHash(token) !== invite.tokenHash) {
        // token was reissued; old signed tokens must die even if unexpired
        throw new AppError(ErrorCodes.E_TOKEN_REVOKED, 'This link has been replaced — use the newest link', 401);
      }

      req.clientScope = {
        inviteId: invite.id,
        firmId: invite.firmId,
        payerId: invite.payerId,
        taxYear: invite.taxYear,
        formTypes: invite.formTypes,
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Recipient zone: signed token → delivery row. Last-4 challenge enforced per-route. */
export function requireRecipientToken() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = (req.params['token'] as string | undefined) ?? (req.query['t'] as string | undefined);
      if (!token) throw AppError.auth('Link token required');
      const crypto = getCrypto();
      const verified = crypto.verifyScopedToken(token, 'recipient');
      if (!verified) throw new AppError(ErrorCodes.E_TOKEN_EXPIRED, 'This link has expired or is invalid', 401);

      const db = getDb();
      const delivery = await db.query.deliveries.findFirst({ where: eq(deliveries.id, verified.id) });
      if (!delivery || !delivery.tokenHash) throw AppError.auth('Link not found');
      if (delivery.tokenRevokedAt) throw new AppError(ErrorCodes.E_TOKEN_REVOKED, 'This link has been revoked', 401);
      if (crypto.tokenHash(token) !== delivery.tokenHash) {
        throw new AppError(ErrorCodes.E_TOKEN_REVOKED, 'This link has been replaced by a newer one', 401);
      }
      if (delivery.tokenExpiresAt && delivery.tokenExpiresAt.getTime() < Date.now()) {
        throw new AppError(ErrorCodes.E_TOKEN_EXPIRED, 'This link has expired', 401);
      }

      const record = await db.query.formRecords.findFirst({
        where: (fr, { eq: e }) => e(fr.id, delivery.formRecordId),
      });
      if (!record) throw AppError.notFound('Form');

      const challenged = await getRedis().get(`recip-ok:${delivery.id}`);
      req.recipientScope = {
        deliveryId: delivery.id,
        formRecordId: delivery.formRecordId,
        recipientId: record.recipientId,
        firmId: delivery.firmId,
        challengePassed: challenged === '1',
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireChallengePassed() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.recipientScope?.challengePassed) {
      return next(new AppError(ErrorCodes.E_CHALLENGE_FAILED, 'Identity verification required', 403));
    }
    next();
  };
}
