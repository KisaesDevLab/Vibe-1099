/**
 * Vibe Auth (SSO) product-side glue that needs no database: the break-glass
 * username ↔ email mapping the CLI and the login guard rely on, and the role
 * vocabulary the identity provider's groups map into.
 */
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { makeLoginInput, zEmail, zLoginInput } from '@vibe1099/shared';
import {
  BREAKGLASS_USERNAME,
  VIBE_1099_ROLES,
  breakglassEmailFor,
  breakglassPatchViolation,
  isBreakglassEmail,
  localLoginIdentifier,
  resolveLoginEmail,
  roleSyncRefusal,
  selfServiceResetRefusal,
} from '../apps/api/src/lib/vibeAuthUsers.js';

const BREAKGLASS_EMAIL = 'vibe-breakglass@vibe-1099.local';

describe('vibe-auth break-glass addressing', () => {
  it('derives an email the login form accepts (zEmail needs a TLD, so never @localhost)', () => {
    const email = breakglassEmailFor(BREAKGLASS_USERNAME);
    expect(email).toBe('vibe-breakglass@vibe-1099.local');
    expect(zEmail.safeParse(email).success).toBe(true);
    expect(zEmail.safeParse('vibe-breakglass@localhost').success).toBe(false);
  });

  it('maps the break-glass email back to the username the package compares against', () => {
    expect(localLoginIdentifier('Vibe-Breakglass@vibe-1099.local')).toBe(BREAKGLASS_USERNAME);
    expect(localLoginIdentifier(' admin@firm.example ')).toBe('admin@firm.example');
  });
});

describe('vibe-auth break-glass sign-in by bare username', () => {
  const login = (email: string) => makeLoginInput(BREAKGLASS_USERNAME).safeParse({ email, password: 'x' }).success;

  it('the LOGIN schema accepts an email or the break-glass username (case-insensitive), nothing else', () => {
    expect(login('admin@demo.firm')).toBe(true);
    expect(login(BREAKGLASS_EMAIL)).toBe(true);
    expect(login('vibe-breakglass')).toBe(true);
    expect(login('Vibe-BreakGlass')).toBe(true);
    expect(login(' vibe-breakglass ')).toBe(true);
    expect(login('vibe-breakglass2')).toBe(false);
    expect(login('admin')).toBe(false);
    expect(login('')).toBe(false);
    expect(login('vibe-breakglass@localhost')).toBe(false);
    expect(zLoginInput.safeParse({ email: 'vibe-breakglass', password: 'x' }).success).toBe(true);
  });

  it('follows a configured VIBE_BREAKGLASS_USERNAME', () => {
    const custom = makeLoginInput('Firm-Rescue');
    expect(custom.safeParse({ email: 'firm-rescue', password: 'x' }).success).toBe(true);
    expect(custom.safeParse({ email: 'vibe-breakglass', password: 'x' }).success).toBe(false);
  });

  it('leaves every other use of zEmail strict', () => {
    expect(zEmail.safeParse('vibe-breakglass').success).toBe(false);
  });

  it('resolves the username to the stored address, and the package still sees the username', () => {
    expect(resolveLoginEmail('vibe-breakglass')).toBe(BREAKGLASS_EMAIL);
    expect(resolveLoginEmail(' Vibe-Breakglass ')).toBe(BREAKGLASS_EMAIL);
    expect(resolveLoginEmail('Admin@Demo.Firm')).toBe('admin@demo.firm');
    expect(localLoginIdentifier(resolveLoginEmail('VIBE-BREAKGLASS'))).toBe(BREAKGLASS_USERNAME);
    expect(localLoginIdentifier(resolveLoginEmail('Admin@Demo.Firm'))).toBe('admin@demo.firm');
  });
});

describe('vibe-auth break-glass account protection (user admin)', () => {
  const bg = { email: BREAKGLASS_EMAIL };
  const staff = { email: 'pat@demo.firm' };

  it('refuses deactivation, demotion and a changed address (the rule takes no sign-in mode: it holds in all of them)', () => {
    expect(breakglassPatchViolation(bg, { active: false })).toBe('active');
    expect(breakglassPatchViolation(bg, { role: 'reviewer' })).toBe('role');
    expect(breakglassPatchViolation(bg, { role: 'preparer' })).toBe('role');
    expect(breakglassPatchViolation(bg, { email: 'someone@demo.firm' })).toBe('email');
  });

  it('lets through what the edit dialog round-trips unchanged, and a reactivation', () => {
    expect(breakglassPatchViolation(bg, { email: 'Vibe-Breakglass@vibe-1099.local', role: 'admin' })).toBeNull();
    expect(breakglassPatchViolation(bg, { active: true })).toBeNull();
    expect(breakglassPatchViolation(bg, {})).toBeNull();
  });

  it('does not touch ordinary users', () => {
    expect(breakglassPatchViolation(staff, { active: false, role: 'preparer', email: 'x@demo.firm' })).toBeNull();
    expect(isBreakglassEmail(' VIBE-BREAKGLASS@vibe-1099.local ')).toBe(true);
    expect(isBreakglassEmail('pat@demo.firm')).toBe(false);
  });
});

describe('vibe-auth self-service password reset policy', () => {
  it('refuses the break-glass account by rule, even with a usable password', () => {
    expect(selfServiceResetRefusal({ email: BREAKGLASS_EMAIL, ssoOnlySince: null })).toBe('breakglass');
  });

  it('refuses an SSO-provisioned account that never had a local password', () => {
    expect(selfServiceResetRefusal({ email: 'kurt@demo.firm', ssoOnlySince: new Date() })).toBe('sso_only');
  });

  it('allows local accounts, including ones later linked to an identity (marker stays NULL)', () => {
    expect(selfServiceResetRefusal({ email: 'pat@demo.firm', ssoOnlySince: null })).toBeNull();
  });
});

describe('vibe-auth role sync never demotes the last active admin', () => {
  const admin = { email: 'kurt@demo.firm', role: 'admin' };

  it('keeps the role when no OTHER active admin exists', () => {
    expect(roleSyncRefusal(admin, 'preparer', false)).toBe('last_active_admin');
    expect(roleSyncRefusal(admin, 'reviewer', false)).toBe('last_active_admin');
  });

  it('demotes normally when another active admin exists', () => {
    expect(roleSyncRefusal(admin, 'preparer', true)).toBeNull();
  });

  it('never demotes the break-glass account, and ignores non-demotions', () => {
    expect(roleSyncRefusal({ email: BREAKGLASS_EMAIL, role: 'admin' }, 'preparer', true)).toBe('breakglass');
    expect(roleSyncRefusal(admin, 'admin', false)).toBeNull();
    expect(roleSyncRefusal({ email: 'pat@demo.firm', role: 'preparer' }, 'reviewer', false)).toBeNull();
    expect(roleSyncRefusal({ email: 'pat@demo.firm', role: 'reviewer' }, 'admin', false)).toBeNull();
  });
});

describe('vibe-auth role vocabulary', () => {
  it('covers every default Vibe group with a product role, most privileged first', () => {
    expect(VIBE_1099_ROLES.roles).toEqual(['admin', 'reviewer', 'preparer']);
    expect(VIBE_1099_ROLES.adminRole).toBe('admin');
    for (const g of ['vibe-admin', 'vibe-it', 'vibe-partner', 'vibe-manager', 'vibe-staff']) {
      const role = VIBE_1099_ROLES.defaultRoleMap?.[g];
      expect(role, g).toBeDefined();
      expect(VIBE_1099_ROLES.roles).toContain(role);
    }
    expect(VIBE_1099_ROLES.defaultRoleMap?.['vibe-manager']).toBe('reviewer');
    expect(VIBE_1099_ROLES.defaultRoleMap?.['vibe-staff']).toBe('preparer');
  });

  it('pins the explicit group -> role map (docs/SSO.md) instead of relying on the package default', () => {
    expect(VIBE_1099_ROLES.defaultRoleMap).toEqual({
      'vibe-admin': 'admin',
      'vibe-it': 'admin',
      'vibe-partner': 'admin',
      'vibe-manager': 'reviewer',
      'vibe-staff': 'preparer',
    });
  });

  it('is what the package resolves by default, and VIBE_OIDC_ROLE_MAP (operator key) still overrides it', async () => {
    // the package is a dependency of apps/api, not of the workspace root
    const pkg = createRequire(realpathSync('apps/api/package.json'))('@kisaesdevlab/vibe-auth') as {
      loadEnvConfig(env: Record<string, string | undefined>): unknown;
      resolveEffectiveConfig(i: unknown): Promise<{ oidc: { roleMap: Record<string, string> } | null }>;
    };
    const resolve = async (extra: Record<string, string>) =>
      pkg.resolveEffectiveConfig({
        env: pkg.loadEnvConfig({ VIBE_AUTH_MODE: 'both', VIBE_OIDC_ISSUER: 'https://idp.example/o/vibe-1099/', VIBE_OIDC_CLIENT_ID: 'vibe-1099', ...extra }),
        stored: null,
        vocabulary: VIBE_1099_ROLES,
        secretWrap: { wrap: async (p: string) => p, unwrap: async (w: string) => w },
      });
    expect((await resolve({})).oidc?.roleMap).toEqual(VIBE_1099_ROLES.defaultRoleMap);
    const overridden = await resolve({ VIBE_OIDC_ROLE_MAP: '{"firm-owners":"admin","vibe-staff":"reviewer"}' });
    expect(overridden.oidc?.roleMap).toEqual({ 'firm-owners': 'admin', 'vibe-staff': 'reviewer' });
  });
});
