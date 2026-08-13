import { describe, expect, it } from 'vitest';
import { buildTaxBanditsPayload, preSubmitCheckTaxBandits, toTaxBanditsWire } from '@vibe1099/core/taxbandits/payload';
import { TaxBanditsClient, taxbanditsEndpoints } from '@vibe1099/core/taxbandits/client';
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

// Ack derivation from the REAL Status response: no top-level status; per-record
// FederalReturn.Status, where TRANSMITTED/SENT TO AGENCY are NON-terminal.
describe('TaxBandits status/ack parsing', () => {
  const clientWith = (statusBody: unknown): TaxBanditsClient => {
    const fetchImpl = (async (url: unknown) => {
      if (String(url).includes('tbsauth')) {
        return new Response(JSON.stringify({ AccessToken: 'tok', TokenType: 'Bearer', ExpiresIn: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify(statusBody), { status: 200 });
    }) as typeof fetch;
    return new TaxBanditsClient(
      taxbanditsEndpoints('https://mock.test', 'https://mock.test/v2/tbsauth'),
      { clientId: 'c', clientSecret: 's', userToken: 'u' },
      fetchImpl,
    );
  };
  const record = (payeeRef: string, status: string, errors: Array<{ Id: string; Message: string }> | null = null) => ({
    PayeeRef: payeeRef,
    RecordId: `TB-${payeeRef}`,
    FederalReturn: { Status: status, Errors: errors },
  });
  const wrap = (success: unknown[], errorRecords: unknown[] | null = null) => ({
    StatusCode: 200,
    SubmissionId: 'SUB1',
    Form1099Records: { SuccessRecords: success, ErrorRecords: errorRecords },
  });

  it('TRANSMITTED / SENT TO AGENCY are still Processing — never accepted', async () => {
    for (const s of ['CREATED', 'TRANSMITTED', 'SENT TO AGENCY', 'UNDER PROCESS', 'YET_TO_RETRANSMIT']) {
      const r = await clientWith(wrap([record('rec-1', s)])).status('SUB1', { formType: 'NEC' });
      expect(r.status, s).toBe('Processing');
    }
  });

  it('all accepted → Accepted with no errors', async () => {
    const r = await clientWith(wrap([record('rec-1', 'ACCEPTED'), record('rec-2', 'Accepted')])).status('SUB1');
    expect(r.status).toBe('Accepted');
    expect(r.errors).toEqual([]);
  });

  it('partial rejection → AcceptedWithErrors with errors keyed by PayeeRef', async () => {
    const r = await clientWith(
      wrap([record('rec-1', 'ACCEPTED'), record('rec-2', 'REJECTED', [{ Id: 'F00-100112', Message: 'TIN/Name mismatch' }])]),
    ).status('SUB1');
    expect(r.status).toBe('AcceptedWithErrors');
    expect(r.errors).toEqual([{ recordId: 'rec-2', code: 'F00-100112', message: 'TIN/Name mismatch' }]);
  });

  it('rejection without agency detail still yields a rejecting error row', async () => {
    const r = await clientWith(wrap([record('rec-1', 'ACCEPTED'), record('rec-2', 'REJECTED')])).status('SUB1');
    expect(r.errors.some((e) => e.recordId === 'rec-2' && e.code === 'REJECTED')).toBe(true);
  });

  it('everything rejected → Rejected; mixed processing wins over terminal', async () => {
    const all = await clientWith(wrap([record('rec-1', 'REJECTED'), record('rec-2', 'REJECTED')])).status('SUB1');
    expect(all.status).toBe('Rejected');
    const mixed = await clientWith(wrap([record('rec-1', 'ACCEPTED'), record('rec-2', 'TRANSMITTED')])).status('SUB1');
    expect(mixed.status).toBe('Processing');
  });

  it('create-time ErrorRecords surfacing at status count as rejected', async () => {
    const r = await clientWith(
      wrap([record('rec-1', 'ACCEPTED')], [{ PayeeRef: 'rec-2', Errors: [{ Id: 'F01-100230', Message: 'Invalid ZIP' }] }]),
    ).status('SUB1');
    expect(r.status).toBe('AcceptedWithErrors');
    expect(r.errors).toEqual([{ recordId: 'rec-2', code: 'F01-100230', message: 'Invalid ZIP' }]);
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
