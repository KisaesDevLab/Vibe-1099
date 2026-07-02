/**
 * Staff auth (Phase 2): argon2id login, session cookies, CSRF bootstrap,
 * optional TOTP, password reset, user admin.
 */
import { Router } from 'express';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, ErrorCodes, zEmail, zLoginInput, zUserRole } from '@vibe1099/shared';
import { audit, getCrypto, getQueue, loadEnv, QUEUE_NAMES, type DeliveryJob } from '@vibe1099/core';
import { getDb, passwordResets, users } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { rateLimit, checkLockout, recordFailure, clearFailures } from '../middleware/rate-limit.js';
import { createSession, destroySession, requireStaff, CSRF_COOKIE, SESSION_COOKIE } from '../middleware/auth.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../services/totp.js';

export const ARGON_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const; // argon2id OWASP baseline

export const authRouter = Router();

const cookieOpts = (secure: boolean) => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure,
  path: '/',
});

authRouter.post(
  '/login',
  rateLimit({ key: 'login', limit: 10, windowSec: 300 }),
  h(async (req, res) => {
    const input = zLoginInput.parse(req.body);
    const db = getDb();
    const lockKey = `login:${input.email.toLowerCase()}`;
    await checkLockout(lockKey, 8, 900);

    const user = await db.query.users.findFirst({ where: eq(users.email, input.email.toLowerCase()) });
    const dummyHash = '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const ok = await argonVerify(user?.passwordHash ?? dummyHash, input.password).catch(() => false);
    if (!user || !user.active || !ok) {
      await recordFailure(lockKey);
      throw new AppError(ErrorCodes.E_AUTH, 'Invalid email or password', 401);
    }

    if (user.totpEnabled) {
      if (!input.totp) throw new AppError(ErrorCodes.E_AUTH, 'TOTP code required', 401, { totpRequired: true });
      const secret = getCrypto().decrypt(user.totpSecretEncrypted ?? '');
      if (!verifyTotp(secret, input.totp)) {
        await recordFailure(lockKey);
        throw new AppError(ErrorCodes.E_AUTH, 'Invalid TOTP code', 401, { totpRequired: true });
      }
    }

    await clearFailures(lockKey);
    const sid = await createSession({
      userId: user.id,
      firmId: user.firmId,
      role: user.role,
      email: user.email,
      name: user.name,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

    const env = loadEnv();
    const secure = env.NODE_ENV === 'production' && env.APP_BASE_URL.startsWith('https');
    res.cookie(SESSION_COOKIE, sid, cookieOpts(secure));
    res.cookie(CSRF_COOKIE, getCrypto().newToken(16), { ...cookieOpts(secure), httpOnly: false });

    await audit(getDb(), {
      firmId: user.firmId,
      actorType: 'staff',
      actorId: user.id,
      action: 'auth.login',
      entityType: 'user',
      entityId: user.id,
      ip: req.ip,
    });

    res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role, totpEnabled: user.totpEnabled } });
  }),
);

authRouter.post(
  '/logout',
  h(async (req, res) => {
    const sid = (req.cookies as Record<string, string>)[SESSION_COOKIE];
    if (sid) await destroySession(sid);
    res.clearCookie(SESSION_COOKIE);
    res.clearCookie(CSRF_COOKIE);
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  requireStaff(),
  h(async (req, res) => {
    res.json({ user: req.staff });
  }),
);

// --- password reset ----------------------------------------------------------

authRouter.post(
  '/password-reset/request',
  rateLimit({ key: 'pwreset', limit: 5, windowSec: 900 }),
  h(async (req, res) => {
    const { email } = z.object({ email: zEmail }).parse(req.body);
    const db = getDb();
    const user = await db.query.users.findFirst({ where: eq(users.email, email.toLowerCase()) });
    if (user && user.active) {
      const crypto = getCrypto();
      const token = crypto.newToken();
      await db.insert(passwordResets).values({
        userId: user.id,
        tokenHash: crypto.tokenHash(token),
        expiresAt: new Date(Date.now() + 60 * 60_000),
      });
      const env = loadEnv();
      const job: DeliveryJob = {
        kind: 'password_reset',
        channel: 'email',
        firmId: user.firmId,
        to: user.email,
        templateKey: 'password_reset',
        vars: { link: `${env.APP_BASE_URL}/reset-password?token=${token}` },
      };
      await getQueue(QUEUE_NAMES.delivery).add('password_reset', job);
    }
    // uniform response — no account enumeration
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/password-reset/complete',
  rateLimit({ key: 'pwreset2', limit: 10, windowSec: 900 }),
  h(async (req, res) => {
    const { token, password } = z.object({ token: z.string().min(10), password: z.string().min(12).max(200) }).parse(req.body);
    const db = getDb();
    const crypto = getCrypto();
    const row = await db.query.passwordResets.findFirst({ where: eq(passwordResets.tokenHash, crypto.tokenHash(token)) });
    if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
      throw new AppError(ErrorCodes.E_TOKEN_EXPIRED, 'Reset link is invalid or expired', 401);
    }
    await db.update(passwordResets).set({ usedAt: new Date() }).where(eq(passwordResets.id, row.id));
    await db.update(users).set({ passwordHash: await argonHash(password, ARGON_OPTS) }).where(eq(users.id, row.userId));
    res.json({ ok: true });
  }),
);

// --- TOTP --------------------------------------------------------------------

authRouter.post(
  '/totp/setup',
  requireStaff(),
  h(async (req, res) => {
    const secret = generateTotpSecret();
    const crypto = getCrypto();
    await getDb()
      .update(users)
      .set({ totpSecretEncrypted: crypto.encrypt(secret), totpEnabled: false })
      .where(eq(users.id, req.staff!.userId));
    res.json({ secret, otpauthUrl: otpauthUrl(secret, req.staff!.email) });
  }),
);

authRouter.post(
  '/totp/confirm',
  requireStaff(),
  h(async (req, res) => {
    const { code } = z.object({ code: z.string().length(6) }).parse(req.body);
    const db = getDb();
    const user = await db.query.users.findFirst({ where: eq(users.id, req.staff!.userId) });
    if (!user?.totpSecretEncrypted) throw AppError.validation('Run TOTP setup first');
    if (!verifyTotp(getCrypto().decrypt(user.totpSecretEncrypted), code)) {
      throw new AppError(ErrorCodes.E_AUTH, 'Code does not match — try again', 401);
    }
    await db.update(users).set({ totpEnabled: true }).where(eq(users.id, user.id));
    res.json({ ok: true });
  }),
);

// --- user admin (admin role) ---------------------------------------------------

const zUserInput = z.object({
  email: zEmail,
  name: z.string().min(1).max(120),
  role: zUserRole,
  password: z.string().min(12).max(200),
});

authRouter.get(
  '/users',
  requireStaff('admin'),
  h(async (req, res) => {
    const rows = await getDb().query.users.findMany({ where: eq(users.firmId, req.staff!.firmId) });
    res.json({
      users: rows.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        active: u.active,
        totpEnabled: u.totpEnabled,
        lastLoginAt: u.lastLoginAt,
      })),
    });
  }),
);

authRouter.post(
  '/users',
  requireStaff('admin'),
  h(async (req, res) => {
    const input = zUserInput.parse(req.body);
    const db = getDb();
    const [created] = await db
      .insert(users)
      .values({
        firmId: req.staff!.firmId,
        email: input.email.toLowerCase(),
        name: input.name,
        role: input.role,
        passwordHash: await argonHash(input.password, ARGON_OPTS),
      })
      .returning({ id: users.id });
    res.locals['audit'] = { action: 'user.create', entityType: 'user', entityId: created?.id };
    res.status(201).json({ id: created?.id });
  }),
);

authRouter.patch(
  '/users/:id',
  requireStaff('admin'),
  h(async (req, res) => {
    const patch = z
      .object({ name: z.string().min(1).max(120).optional(), role: zUserRole.optional(), active: z.boolean().optional() })
      .parse(req.body);
    const db = getDb();
    const id = z.string().uuid().parse(req.params['id']);
    await db
      .update(users)
      .set(patch)
      .where(and(eq(users.id, id), eq(users.firmId, req.staff!.firmId)));
    res.locals['audit'] = { action: 'user.update', entityType: 'user', entityId: id, detail: patch };
    res.json({ ok: true });
  }),
);
