import { describe, expect, it } from 'vitest';
import { buildTaxBanditsPayload, preSubmitCheckTaxBandits, toTaxBanditsWire } from '@vibe1099/core/taxbandits/payload';
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

// Wire contract (developer.taxbandits.com v1.7.3): Create requires
// { SubmissionManifest, ReturnHeader, ReturnData } — the live API rejects a
// missing ReturnHeader with F01-100064 (hit in production 2026-08-13).
describe('TaxBandits wire format', () => {
  const wire = toTaxBanditsWire(buildTaxBanditsPayload(baseInput(), 'sandbox')) as any;

  it('carries the three top-level blocks their validator requires', () => {
    expect(wire.SubmissionManifest).toBeDefined();
    expect(wire.ReturnHeader?.Business).toBeDefined();
    expect(Array.isArray(wire.ReturnData)).toBe(true);
    expect(wire.SubmissionManifest.TaxYear).toBe('2026');
    expect(wire.SubmissionManifest.IRSFilingType).toBe('IRIS');
    expect(wire.SubmissionManifest.IsFederalFiling).toBe(true);
  });

  it('maps the business with hyphenated EIN and US address', () => {
    const b = wire.ReturnHeader.Business;
    expect(b.BusinessNm).toBe('ACME & SONS LLC');
    expect(b.IsEIN).toBe(true);
    expect(b.EINorSSN).toBe('43-1111111');
    expect(b.USAddress).toMatchObject({ Address1: '200 Commerce Way', City: 'Kansas City', State: 'MO', ZipCd: '64106' });
  });

  it('maps NEC boxes to NECFormData with required-zero defaults and state block', () => {
    const rd = wire.ReturnData[0];
    expect(rd.SequenceId).toBe('1');
    expect(rd.NECFormData.B1NEC).toBe(12500);
    expect(rd.NECFormData.B4FedTaxWH).toBe(0); // required even when absent
    expect(rd.NECFormData.B2IsDirectSales).toBe(true);
    expect(rd.NECFormData.Is2ndTINnot).toBe(true);
    expect(rd.NECFormData.AccountNum).toBe('NEC2026-001');
    expect(rd.NECFormData.States[0]).toMatchObject({ StateCd: 'MO', StateWH: 250 });
  });

  it('splits an SSN recipient into FirstNm/LastNm with formatted TIN', () => {
    const r = wire.ReturnData[0].Recipient;
    expect(r).toMatchObject({ TINType: 'SSN', TIN: '400-11-1222', FirstNm: 'JORDAN', LastNm: 'ABLE', PayeeRef: 'rec-1', IsForeign: false });
  });

  it('maps MISC boxes to MISCFormData names', () => {
    const input = baseInput();
    input.records[0] = {
      ...input.records[0]!,
      formType: 'MISC',
      boxValues: { box1: 300000, box3: 12345, fatca: true, stateTaxWithheld: 25000, stateCode: 'MO' },
    };
    const w = toTaxBanditsWire(buildTaxBanditsPayload(input, 'sandbox')) as any;
    expect(w.ReturnData[0].MISCFormData).toMatchObject({ B1Rents: 3000, B3OtherIncome: 123.45, B13IsFATCA: true });
    expect(w.ReturnData[0].NECFormData).toBeUndefined();
  });

  it('refuses a mixed-form-type submission (their Create endpoints are per form)', () => {
    const input = baseInput();
    input.records.push({ ...input.records[0]!, recordId: 'rec-2', formType: 'MISC' });
    expect(() => toTaxBanditsWire(buildTaxBanditsPayload(input, 'sandbox'))).toThrow(/single supported form type/);
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
