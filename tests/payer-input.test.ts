import { describe, expect, it } from 'vitest';
import { zPayerInput } from '@vibe1099/shared';

/**
 * Regression: a payer whose filingProviderOverride was 'taxbandits' could not
 * be edited AT ALL. The Payers form round-trips the payer's current values
 * back on save, so a provider missing from this enum rejected the whole
 * update with "Invalid enum value" — the edit silently refused to save.
 *
 * Every provider kind the database allows (migration 0005) must be accepted
 * here, and the UI dropdown must offer them, or the same class of bug returns
 * the next time a provider is added.
 */
const PROVIDER_KINDS = ['iris', 'tax1099', 'taxbandits'] as const;

const basePayer = {
  legalName: 'ACME CONSTRUCTION LLC',
  tin: '431111111',
  tinType: 'EIN' as const,
  address: { line1: '200 Commerce Way', city: 'Kansas City', state: 'MO', zip: '64106' },
};

describe('payer input — filing provider override', () => {
  for (const kind of PROVIDER_KINDS) {
    it(`accepts '${kind}' on create`, () => {
      expect(zPayerInput.safeParse({ ...basePayer, filingProviderOverride: kind }).success).toBe(true);
    });

    it(`accepts '${kind}' on a partial (edit) update`, () => {
      // this is exactly what the Payers form sends when saving an edit
      expect(zPayerInput.partial().safeParse({ legalName: 'ACME', filingProviderOverride: kind }).success).toBe(true);
    });
  }

  it('accepts null (inherit the firm default)', () => {
    expect(zPayerInput.partial().safeParse({ filingProviderOverride: null }).success).toBe(true);
  });

  it('still rejects an unknown provider', () => {
    expect(zPayerInput.partial().safeParse({ filingProviderOverride: 'acme-filings' }).success).toBe(false);
  });
});

describe('payer edit round-trip', () => {
  it('accepts the full body the Payers form sends on edit (no TIN re-entered)', () => {
    const body = {
      legalName: 'SUNRISE LANDSCAPING LLC',
      clientId: null,
      firstName: null,
      lastName: null,
      dbaName: '',
      address: { line1: '500 Commerce Way', line2: '', city: 'Kansas City', state: 'MO', zip: '64106' },
      phone: '8165550100',
      contactEmail: 'owner@example.com',
      contactMobile: null,
      moWithholdingId: null,
      moSourceDefault: false,
      filingProviderOverride: 'taxbandits',
      defaultFormTypes: ['NEC'],
    };
    const parsed = zPayerInput.partial().safeParse(body);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
  });
});
