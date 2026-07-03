import { describe, expect, it } from 'vitest';
import { buildTaxBanditsPayload, preSubmitCheckTaxBandits } from '@vibe1099/core/taxbandits/payload';
import { buildAssertion } from '@vibe1099/core/taxbandits/auth';
import type { IrisTransmissionInput } from '@vibe1099/core/iris/xml';

function baseInput(overrides: Partial<IrisTransmissionInput> = {}): IrisTransmissionInput {
  return {
    utid: 'TB-abc',
    tcc: '',
    taxYear: 2026,
    environment: 'ATS',
    transmitter: {
      tcc: '',
      tin: '431234567',
      tinType: 'EIN',
      name1: 'Demo CPA Firm LLC',
      address: { line1: '100 Main St', city: 'Kansas City', state: 'MO', zip: '64105' },
    },
    issuer: {
      tin: '431111111',
      tinType: 'EIN',
      name1: 'ACME & SONS LLC',
      address: { line1: '200 Commerce Way', city: 'Kansas City', state: 'MO', zip: '64106' },
      phone: '8165551212',
    },
    records: [
      {
        recordId: 'rec-1',
        formType: 'NEC',
        taxYear: 2026,
        recipient: {
          tin: '400111222',
          tinType: 'SSN',
          name1: 'JORDAN ABLE',
          address: { line1: '101 Oak St', city: 'Kansas City', state: 'MO', zip: '64100' },
        },
        boxValues: { box1: 1250000, directSales: true, stateTaxWithheld: 25000, stateCode: 'MO' },
        accountNumber: 'NEC2026-001',
        secondTinNotice: true,
      },
    ],
    cfsfStates: ['AR'],
    isCorrection: false,
    ...overrides,
  };
}

describe('TaxBandits payload builder', () => {
  it('maps issuer→business and records with cents as decimal strings', () => {
    const p = buildTaxBanditsPayload(baseInput(), 'sandbox');
    expect(p.submissionRef).toBe('TB-abc');
    expect(p.isTestMode).toBe(true);
    expect(p.business.tin).toBe('431111111');
    expect(p.combinedFederalState).toEqual(['AR']);
    expect(p.records).toHaveLength(1);
    const r = p.records[0]!;
    expect(r.payeeRef).toBe('rec-1');
    expect(r.amounts['box1']).toBe('12500.00');
    expect(r.flags['directSales']).toBe(true);
    expect(r.stateAmounts['stateTaxWithheld']).toBe('250.00');
    expect(r.text['stateCode']).toBe('MO');
    expect(r.secondTinNotice).toBe(true);
  });

  it('threads delivery add-ons (default off — pressure-seal remains primary)', () => {
    expect(buildTaxBanditsPayload(baseInput(), 'sandbox').records[0]!.postalMailing).toBe(false);
    const withMail = buildTaxBanditsPayload(baseInput(), 'sandbox', { postalMailing: true, onlineAccess: true });
    expect(withMail.records[0]!.postalMailing).toBe(true);
    expect(withMail.records[0]!.onlineAccess).toBe(true);
  });

  it('production env is not a test file', () => {
    expect(buildTaxBanditsPayload(baseInput(), 'production').isTestMode).toBe(false);
  });

  it('preSubmitCheck flags a bad recipient TIN but passes a clean payload', () => {
    expect(preSubmitCheckTaxBandits(buildTaxBanditsPayload(baseInput(), 'sandbox'))).toHaveLength(0);
    const bad = baseInput();
    bad.records[0]!.recipient.tin = '12';
    expect(preSubmitCheckTaxBandits(buildTaxBanditsPayload(bad, 'sandbox')).some((m) => /recipient TIN/.test(m))).toBe(true);
  });
});

describe('TaxBandits auth assertion', () => {
  it('builds a three-segment HS256 JWS with the TaxBandits claim set (iss/sub/aud/iat, no exp)', () => {
    const jws = buildAssertion({ clientId: 'cid', clientSecret: 'secret', userToken: 'utok' }, 1_700_000_000_000);
    const parts = jws.split('.');
    expect(parts).toHaveLength(3);
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64').toString());
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64').toString());
    expect(header.alg).toBe('HS256');
    expect(claims.iss).toBe('cid');
    expect(claims.sub).toBe('cid');
    expect(claims.aud).toBe('utok');
    expect(claims.iat).toBe(1_700_000_000); // unix seconds
    expect(claims.exp).toBeUndefined(); // spec: no exp in the request assertion
  });

  it('is deterministic for the same inputs and changes with the secret', () => {
    const a = buildAssertion({ clientId: 'c', clientSecret: 's1', userToken: 'u' }, 1_700_000_000_000);
    const b = buildAssertion({ clientId: 'c', clientSecret: 's1', userToken: 'u' }, 1_700_000_000_000);
    const c = buildAssertion({ clientId: 'c', clientSecret: 's2', userToken: 'u' }, 1_700_000_000_000);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
