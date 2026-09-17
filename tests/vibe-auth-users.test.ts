/**
 * Vibe Auth (SSO) product-side glue that needs no database: the break-glass
 * username ↔ email mapping the CLI and the login guard rely on, and the role
 * vocabulary the identity provider's groups map into.
 */
import { describe, expect, it } from 'vitest';
import { zEmail } from '@vibe1099/shared';
import { BREAKGLASS_USERNAME, VIBE_1099_ROLES, breakglassEmailFor, localLoginIdentifier } from '../apps/api/src/lib/vibeAuthUsers.js';

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
});
