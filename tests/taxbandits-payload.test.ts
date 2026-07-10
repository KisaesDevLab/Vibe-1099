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
  it('emits the real Form1099 envelope: manifest, business, per-form FormData', () => {
    const p = buildTaxBanditsPayload(baseInput());
    expect(p.formType).toBe('NEC');
    expect(p.SubmissionManifest.TaxYear).toBe('2026');
    expect(p.SubmissionManifest.IsFederalFiling).toBe(true);
    expect(p.SubmissionManifest.IsStateFiling).toBe(true); // has a state withholding block
    expect(p.SubmissionManifest.IsPostal).toBe(false); // pressure-seal remains primary
    expect(p.ReturnHeader.Business.EINorSSN).toBe('431111111');
    expect(p.ReturnHeader.Business.IsEIN).toBe(true);
    expect(p.ReturnHeader.Business.USAddress.City).toBe('Kansas City');
    expect(p.ReturnData).toHaveLength(1);
    const r = p.ReturnData[0]!;
    expect(r.SequenceId).toBe('rec-1');
    expect(r.Recipient.TIN).toBe('400111222');
    const data = r.NECFormData!;
    expect(data['B1NEC']).toBe(12500); // integer cents → JSON number
    expect(data['B2DirectSalesInd']).toBe(true);
    expect(data['AccountNum']).toBe('NEC2026-001');
    expect(data['IsSecondTINnot']).toBe(true);
    expect(data['States']).toEqual([{ StateCd: 'MO', StateWHAmt: 250 }]);
  });

  it('maps MISC boxes to their form-specific FormData fields', () => {
    const input = baseInput();
    input.records[0]!.formType = 'MISC';
    input.records[0]!.boxValues = { box1: 100000, box6: 50000, directSales: true };
    const r = buildTaxBanditsPayload(input).ReturnData[0]!;
    expect(r.MISCFormData!['B1Rents']).toBe(1000);
    expect(r.MISCFormData!['B6MedHealthCarePymt']).toBe(500);
    expect(r.MISCFormData!['B7DirectSalesInd']).toBe(true);
    expect(r.NECFormData).toBeUndefined();
  });

  it('threads delivery add-ons into the submission manifest (default off)', () => {
    expect(buildTaxBanditsPayload(baseInput()).SubmissionManifest.IsPostal).toBe(false);
    const withMail = buildTaxBanditsPayload(baseInput(), { postalMailing: true, onlineAccess: true });
    expect(withMail.SubmissionManifest.IsPostal).toBe(true);
    expect(withMail.SubmissionManifest.IsOnlineAccess).toBe(true);
  });

  it('rejects a batch that mixes form types (one form type per submission)', () => {
    const input = baseInput();
    input.records = [
      { ...input.records[0]!, recordId: 'a', formType: 'NEC' },
      { ...input.records[0]!, recordId: 'b', formType: 'MISC' },
    ];
    expect(() => buildTaxBanditsPayload(input)).toThrow(/one form type per submission/i);
  });

  it('preSubmitCheck flags a bad recipient TIN but passes a clean payload', () => {
    expect(preSubmitCheckTaxBandits(buildTaxBanditsPayload(baseInput()))).toHaveLength(0);
    const bad = baseInput();
    bad.records[0]!.recipient.tin = '12';
    expect(preSubmitCheckTaxBandits(buildTaxBanditsPayload(bad)).some((m) => /recipient TIN/.test(m))).toBe(true);
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
