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
import { and, asc, eq, ne } from 'drizzle-orm';
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

/** The login form accepts the bare break-glass username too (the Appliance prints only
 *  `username: vibe-breakglass`): resolve it to the address the account is stored under.
 *  Anything else is an email (the login schema guarantees it) and is lower-cased. */
export function resolveLoginEmail(identifier: string): string {
  const id = identifier.trim().toLowerCase();
  return id === BREAKGLASS_USERNAME.toLowerCase() ? breakglassEmailFor(BREAKGLASS_USERNAME) : id;
}

export function isBreakglassEmail(email: string): boolean {
  return email.trim().toLowerCase() === breakglassEmailFor(BREAKGLASS_USERNAME);
}

export const BREAKGLASS_PROTECTED_MESSAGE =
  'The break-glass admin is the recovery account: it cannot be deactivated, demoted from admin or re-addressed. ' +
  'To change its password run `vibe identity rotate-breakglass` on the appliance (`pnpm vibe-auth breakglass rotate` standalone).';

/** Which protected property of the break-glass account a user-admin PATCH would change
 *  (in EVERY sign-in mode), or null when the patch is harmless (name, or the same values
 *  round-tripped by the edit dialog). A changed address would break findByUsername. */
export function breakglassPatchViolation(
  target: { email: string },
  patch: { active?: boolean; role?: string; email?: string },
): 'active' | 'role' | 'email' | null {
  if (!isBreakglassEmail(target.email)) return null;
  if (patch.active === false) return 'active';
  if (patch.role !== undefined && patch.role !== VIBE_1099_ROLES.adminRole) return 'role';
  if (patch.email !== undefined && patch.email.trim().toLowerCase() !== target.email.toLowerCase()) return 'email';
  return null;
}

/** Self-service password reset (the emailed link) is refused for the break-glass
 *  account, by rule, and for an account Vibe Auth provisioned that never had a local
 *  password (users.sso_only_since): a mailbox must not mint a local credential for an
 *  SSO-created account. An admin can still set one (POST /auth/users/:id/reset-password). */
export function selfServiceResetRefusal(user: { email: string; ssoOnlySince: Date | null }): 'breakglass' | 'sso_only' | null {
  if (isBreakglassEmail(user.email)) return 'breakglass';
  if (user.ssoOnlySince) return 'sso_only';
  return null;
}

/** Is there an active admin in the firm other than `exceptUserId`? The break-glass
 *  account does NOT count: it is a recovery credential, not somebody's daily admin. */
export async function otherActiveAdminExists(firmId: string, exceptUserId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.firmId, firmId),
        eq(users.role, 'admin'),
        eq(users.active, true),
        ne(users.id, exceptUserId),
        ne(users.email, breakglassEmailFor(BREAKGLASS_USERNAME)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Why a role sync from the identity provider must NOT be applied, or null. */
export function roleSyncRefusal(
  target: { email: string; role: string },
  newRole: string,
  hasOtherActiveAdmin: boolean,
): 'breakglass' | 'last_active_admin' | null {
  if (target.role !== VIBE_1099_ROLES.adminRole || newRole === VIBE_1099_ROLES.adminRole) return null;
  if (isBreakglassEmail(target.email)) return 'breakglass';
  return hasOtherActiveAdmin ? null : 'last_active_admin';
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

/** I7: a JIT user gets a random hash nobody can match, and `sso_only_since` marks the row so
 *  the self-service password reset refuses it (selfServiceResetRefusal): the account signs in
 *  through the identity provider only, until an admin deliberately sets a local password. */
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
          ssoOnlySince: new Date(),
          lastLoginAt: new Date(),
        })
        .returning();
      return toVibeUser(row!);
    },

    /** Role sync from the IdP groups. Never throws (it would fail the sign-in): a sync that
     *  would demote the firm's last active admin — or the break-glass account — is skipped
     *  and audited instead; the session adapter reads the role back from the row. */
    async setRole(userId, role) {
      const [target] = await db().select().from(users).where(eq(users.id, userId)).limit(1);
      if (target) {
        const demotion = target.role === VIBE_1099_ROLES.adminRole && role !== VIBE_1099_ROLES.adminRole;
        const refusal = roleSyncRefusal(target, role, demotion ? await otherActiveAdminExists(target.firmId, target.id) : true);
        if (refusal) {
          await audit(db(), {
            firmId: target.firmId,
            actorType: 'system',
            actorId: target.id,
            action: 'vibe.auth.role.sync_refused',
            entityType: 'auth',
            entityId: target.id,
            detail: { user_id: target.id, from: target.role, to: role, reason: refusal },
          });
          return;
        }
      }
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
      await db()
        .update(users)
        .set({ passwordHash: await argonHash(password, ARGON_OPTS), ssoOnlySince: null })
        .where(eq(users.id, userId));
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
