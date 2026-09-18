/**
 * Vibe Auth (single sign-on) adapters that only need the database: the
 * UserAdapter over `users` and the audit sink over `audit_log`. They live apart
 * from lib/vibeAuth.ts because the break-glass CLI (src/vibeAuthAdapter.ts)
 * loads them in a process that has no Express app and never starts the engine.
 *
 * Single-firm deployment: JIT-provisioned users join the only firm (the one
 * `pnpm bootstrap:firm` created). UNIQUE(firm_id, email) makes email linking safe.
 */
import { randomBytes } from 'node:crypto';
import { hash as argonHash } from '@node-rs/argon2';
import { asc, eq } from 'drizzle-orm';
import type { AuditSink, CreateLocalUserInput, CreateUserInput, RoleVocabulary, UserAdapter, VibeUser } from '@kisaesdevlab/vibe-auth';
import { audit } from '@vibe1099/core';
import { firms, getDb, users } from '@vibe1099/db';
import { ARGON_OPTS } from './argon.js';
import { destroyAllUserSessions } from '../middleware/auth.js';

/** Product roles, most privileged first (D22). Vibe groups map to admin / reviewer / preparer. */
export const VIBE_1099_ROLES: RoleVocabulary = {
  roles: ['admin', 'reviewer', 'preparer'],
  adminRole: 'admin',
  defaultRoleMap: {
    'vibe-admin': 'admin',
    'vibe-it': 'admin',
    'vibe-partner': 'admin',
    'vibe-manager': 'reviewer',
    'vibe-staff': 'preparer',
  },
};

export const BREAKGLASS_USERNAME = process.env.VIBE_BREAKGLASS_USERNAME?.trim() || 'vibe-breakglass';

/** `users` has no username column: the package's break-glass admin is addressed by
 *  the email its username implies. `@localhost` would fail zEmail (needs a TLD). */
export function breakglassEmailFor(username: string): string {
  return `${username.trim().toLowerCase()}@vibe-1099.local`;
}

/** What the package compares against VIBE_BREAKGLASS_USERNAME: the login form posts
 *  an email, so the break-glass address maps back to the username. */
export function localLoginIdentifier(email: string): string {
  const e = email.trim().toLowerCase();
  return e === breakglassEmailFor(BREAKGLASS_USERNAME) ? BREAKGLASS_USERNAME : e;
}

let firmIdCache: string | null = null;

/** The deployment's one firm (first row, as bootstrap-firm/seed define it). */
export async function soleFirmId(): Promise<string> {
  if (firmIdCache) return firmIdCache;
  const [row] = await getDb().select({ id: firms.id }).from(firms).orderBy(asc(firms.createdAt)).limit(1);
  if (!row) throw new Error('Vibe Auth: no firm exists yet — run `pnpm bootstrap:firm` first');
  firmIdCache = row.id;
  return row.id;
}

type UserRow = typeof users.$inferSelect;

function toVibeUser(row: UserRow): VibeUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    active: row.active,
    local: true,
    username: row.email.split('@')[0] ?? row.email,
  };
}

/** I7: a JIT user gets a random hash nobody can match; a password reset still works in `both` mode. */
async function unusablePasswordHash(): Promise<string> {
  return argonHash(randomBytes(32).toString('base64url'), ARGON_OPTS);
}

export function createVibeUsers(): UserAdapter {
  const db = () => getDb();
  const byEmail = async (email: string): Promise<VibeUser | null> => {
    const firmId = await soleFirmId();
    const rows = await db()
      .select()
      .from(users)
      .where(eq(users.email, email.trim().toLowerCase()))
      .limit(5);
    const row = rows.find((r) => r.firmId === firmId) ?? rows[0];
    return row ? toVibeUser(row) : null;
  };
  return {
    async findById(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const rows = await db().select().from(users).where(eq(users.id, id)).limit(1);
      return rows[0] ? toVibeUser(rows[0]) : null;
    },

    findByEmail: byEmail,

    async findByUsername(username) {
      return byEmail(username.includes('@') ? username : breakglassEmailFor(username));
    },

    /** Just-in-time provisioning from a verified Vibe Auth identity. */
    async create(input: CreateUserInput) {
      const email = input.email.trim().toLowerCase();
      const [row] = await db()
        .insert(users)
        .values({
          firmId: await soleFirmId(),
          email,
          name: (input.name ?? email).slice(0, 120),
          role: input.role as UserRow['role'],
          passwordHash: await unusablePasswordHash(),
          lastLoginAt: new Date(),
        })
        .returning();
      return toVibeUser(row!);
    },

    async setRole(userId, role) {
      await db().update(users).set({ role: role as UserRow['role'] }).where(eq(users.id, userId));
    },

    /** Break-glass provisioning (D12): an ACTIVE local admin with a real password, no TOTP
     *  (the CLI cannot enrol one; the login route accepts password alone when totpEnabled is false). */
    async createLocalUser(input: CreateLocalUserInput) {
      const [row] = await db()
        .insert(users)
        .values({
          firmId: await soleFirmId(),
          email: input.email.trim().toLowerCase(),
          name: input.name.slice(0, 120),
          role: input.role as UserRow['role'],
          passwordHash: await argonHash(input.password, ARGON_OPTS),
          active: true,
        })
        .returning();
      return toVibeUser(row!);
    },

    async setLocalPassword(userId, password) {
      await db().update(users).set({ passwordHash: await argonHash(password, ARGON_OPTS) }).where(eq(users.id, userId));
    },

    async setActive(userId, active) {
      await db().update(users).set({ active }).where(eq(users.id, userId));
      if (!active) await destroyAllUserSessions(userId);
    },
  };
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null;
}

/** Every package event lands in audit_log as one row: action = the event type
 *  (vibe.auth.*), entityType = 'auth', detail = the event payload (never tokens
 *  or secrets — see the package's audit schema). */
export const vibeAuditSink: AuditSink = {
  async emit(event) {
    const { type, at, ...rest } = event;
    const firmId = await soleFirmId().catch(() => null);
    await audit(getDb(), {
      firmId,
      actorType: 'system',
      actorId: asString(rest.user_id),
      action: type,
      entityType: 'auth',
      entityId: asString(rest.user_id),
      detail: { ...rest, at },
      ip: asString(rest.ip),
    });
  },
};
