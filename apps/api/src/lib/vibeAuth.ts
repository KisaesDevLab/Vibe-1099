/**
 * Vibe Auth (single sign-on) for the staff realm — Phase 8 step 5.
 *
 * The package owns the OIDC flow (Authorization Code + PKCE), the Settings →
 * Authentication API and the break-glass rules; this module is the product side
 * of the contract:
 *
 *  - SessionAdapter: an SSO login mints an ORDINARY Redis staff session (the same
 *    `v1099_sid` + `v1099_csrf` cookies the password login sets) flagged `sso`.
 *    Redis holds no identity data: issuer / subject / IdP session id / ID token
 *    are parked in Postgres `auth_sessions_oidc`, keyed by HMAC(v1099_sid), so
 *    RP-initiated and back-channel logout can find them. Back-channel logout
 *    resolves the affected users and ends every Redis session they hold.
 *  - Identity / settings stores on the package tables (createPgStores over the
 *    pg pool); client secrets at rest wrapped with the MASTER_KEY envelope
 *    (the same AES-GCM that protects TINs and TOTP secrets — I9).
 *  - Audit events → audit_log through the product's writer (lib/vibeAuthUsers.ts).
 *  - authorizeAdmin: the settings API is outside requireStaff(), so it enforces the
 *    admin role AND the v1099_csrf double-submit on mutations itself.
 *
 * Paths: the engine routes on `/auth/*` with basePath "" — the Appliance's Caddy
 * strips the product prefix before proxying, and our nginx / Vite proxy pass
 * `/auth/*` through unchanged. The public URL (redirect URI the IdP sees) comes
 * from VIBE_OIDC_PUBLIC_URL, never from basePath (I2).
 *
 * Recipient and client portals (capability tokens + OTP + TIN) are untouched (I11).
 */
import type { Request, RequestHandler, Response } from 'express';
import { and, eq, or } from 'drizzle-orm';
import {
  createPgStores,
  createVibeAuth,
  vibeAuthExpress,
  type HttpRequest,
  type SessionAdapter,
  type SessionIdentity,
  type VibeAuth,
  type VibeUser,
} from '@kisaesdevlab/vibe-auth';
import type { UserRole } from '@vibe1099/shared';
import { createLogger, getCrypto, safeHexEqual } from '@vibe1099/core';
import { authSessionsOidc, getDb, getPool, users } from '@vibe1099/db';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  clearSessionCookies,
  createSession,
  destroyAllUserSessions,
  destroySession,
  readStaffSession,
  setSessionCookies,
} from '../middleware/auth.js';
import { VIBE_1099_ROLES, createVibeUsers, vibeAuditSink } from './vibeAuthUsers.js';

export { BREAKGLASS_USERNAME, breakglassEmailFor, localLoginIdentifier } from './vibeAuthUsers.js';

const log = createLogger('api:vibe-auth');

/** The package's stores speak parameterised SQL with $1..$n placeholders — run them on the pg pool behind Drizzle. */
const pgStores = createPgStores({
  query: async (sql, params = []) => (await getPool().query(sql, params)).rows as Array<Record<string, unknown>>,
});

const sidHashOf = (sid: string): string => getCrypto().tokenHash(sid);

function cookieSid(req: Request): string | undefined {
  return (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
}

async function identityForSid(sid: string) {
  const rows = await getDb().select().from(authSessionsOidc).where(eq(authSessionsOidc.sidHash, sidHashOf(sid))).limit(1);
  return rows[0] ?? null;
}

const sessions: SessionAdapter = {
  /** Mint the session the rest of the API already understands, plus the identity row. */
  async create(_req: Request, res: Response, user: VibeUser, identity: SessionIdentity) {
    const db = getDb();
    const [row] = await db.select({ firmId: users.firmId }).from(users).where(eq(users.id, user.id)).limit(1);
    if (!row) throw new Error(`Vibe Auth: user ${user.id} vanished between provisioning and session creation`);
    const now = Date.now();
    const sid = await createSession({
      userId: user.id,
      firmId: row.firmId,
      role: user.role as UserRole,
      email: user.email,
      name: user.name ?? user.email,
      createdAt: now,
      lastSeenAt: now,
      sso: true,
    });
    await db.insert(authSessionsOidc).values({
      sidHash: sidHashOf(sid),
      userId: user.id,
      issuer: identity.issuer,
      subject: identity.subject,
      oidcSid: identity.sid ?? null,
      idToken: identity.idToken ?? null,
    });
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    setSessionCookies(res, sid);
  },

  async destroy(req: Request, res: Response) {
    const sid = cookieSid(req);
    if (sid) {
      await getDb().delete(authSessionsOidc).where(eq(authSessionsOidc.sidHash, sidHashOf(sid)));
      await destroySession(sid);
    }
    clearSessionCookies(res);
  },

  async currentUserId(req: Request) {
    return (await readStaffSession(req))?.session.userId ?? null;
  },

  async currentIdentity(req: Request) {
    const sid = cookieSid(req);
    if (!sid) return null;
    const row = await identityForSid(sid);
    if (!row) return null;
    return { issuer: row.issuer, subject: row.subject, sid: row.oidcSid ?? undefined, idToken: row.idToken ?? undefined };
  },

  /** Back-channel logout (I6, server-side half): find every SSO session for the
   *  identity — by IdP sid, (issuer, subject) or user — and end EVERY Redis session
   *  of those users (an IdP logout means the person is gone, local sessions included). */
  async destroyByIdentity(i) {
    const conds = [];
    if (i.sid) conds.push(eq(authSessionsOidc.oidcSid, i.sid));
    if (i.subject) conds.push(and(eq(authSessionsOidc.issuer, i.issuer), eq(authSessionsOidc.subject, i.subject)));
    if (i.userId) conds.push(eq(authSessionsOidc.userId, i.userId));
    if (!conds.length) return 0;
    const deleted = await getDb()
      .delete(authSessionsOidc)
      .where(conds.length === 1 ? conds[0] : or(...conds))
      .returning({ userId: authSessionsOidc.userId });
    const userIds = new Set(deleted.map((d) => d.userId));
    if (i.userId) userIds.add(i.userId);
    for (const userId of userIds) await destroyAllUserSessions(userId);
    return deleted.length;
  },
};

/** Settings → Authentication API + test-connection popup: admins only, and — because
 *  these routes sit outside requireStaff() — the same CSRF double-submit on mutations. */
async function authorizeAdmin(req: HttpRequest): Promise<{ userId: string } | null> {
  const raw = req.raw.req as Request;
  const found = await readStaffSession(raw);
  if (!found || found.session.role !== VIBE_1099_ROLES.adminRole) return null;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(raw.method)) {
    const cookieToken = (raw.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];
    const headerToken = raw.headers['x-csrf-token'];
    if (!cookieToken || typeof headerToken !== 'string' || !safeHexEqual(cookieToken, headerToken)) return null;
  }
  const [row] = await getDb().select({ active: users.active }).from(users).where(eq(users.id, found.session.userId)).limit(1);
  if (!row?.active) return null;
  return { userId: found.session.userId };
}

let instance: VibeAuth | null = null;

export function getVibeAuth(): VibeAuth {
  if (instance) return instance;
  instance = createVibeAuth({
    product: { slug: 'vibe-1099', name: 'Vibe 1099', roles: VIBE_1099_ROLES },
    users: createVibeUsers(),
    session: sessions,
    identities: pgStores.identities,
    settings: pgStores.settings,
    secretWrap: { wrap: async (p) => getCrypto().encrypt(p), unwrap: async (w) => getCrypto().decrypt(w) },
    audit: vibeAuditSink,
    env: process.env,
    basePath: '',
    loginPath: '/login',
    breakglassLoginPath: '/login/local',
    defaultReturnTo: '/',
    trustProxy: true,
    syncRoles: true,
    authorizeAdmin,
    logger: {
      info: (m, meta) => log.info(meta ?? {}, m),
      warn: (m, meta) => log.warn(meta ?? {}, m),
      error: (m, meta) => log.error(meta ?? {}, m),
    },
  });
  return instance;
}

/** Boot: resolve config and begin IdP discovery. Throws only for the package's one
 *  startup refusal — oidc_only with no active break-glass user — which index.ts
 *  turns into a fatal exit with the package's message (I4). */
export async function startVibeAuth(): Promise<VibeAuth> {
  const auth = getVibeAuth();
  await auth.start();
  const s = auth.status();
  log.info({ mode: s.mode, sso: s.oidc.enabled ? s.oidc.issuer : 'off' }, 'vibe-auth ready');
  return auth;
}

/** Express middleware for the engine's routes (/auth/*). Mount at app level after
 *  the body parsers and cookie parser, before the staff router; every other path
 *  passes straight through. */
export function vibeAuthMiddleware(): RequestHandler {
  return vibeAuthExpress(getVibeAuth());
}
