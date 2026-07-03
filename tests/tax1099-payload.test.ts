import { describe, expect, it } from 'vitest';
import { buildTax1099Payload, preSubmitCheck } from '@vibe1099/core/tax1099/payload';
import type { IrisTransmissionInput } from '@vibe1099/core/iris/xml';

function baseInput(overrides: Partial<IrisTransmissionInput> = {}): IrisTransmissionInput {
  return {
    utid: 'T99-abc',
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

describe('Tax1099 payload builder', () => {
  it('maps issuer→payer and records→forms with cents as decimal strings', () => {
    const p = buildTax1099Payload(baseInput(), 'sandbox');
    expect(p.submissionRef).toBe('T99-abc');
    expect(p.test).toBe(true);
    expect(p.payer.tin).toBe('431111111');
    expect(p.combinedFederalState).toEqual(['AR']);
    expect(p.forms).toHaveLength(1);
    const f = p.forms[0]!;
    expect(f.refId).toBe('rec-1');
    expect(f.amounts['box1']).toBe('12500.00'); // integer cents → decimal string
    expect(f.flags['directSales']).toBe(true);
    expect(f.stateAmounts['stateTaxWithheld']).toBe('250.00'); // state-prefixed box routed aside
    expect(f.text['stateCode']).toBe('MO');
    expect(f.secondTinNotice).toBe(true);
  });

  it('production env is not a test file', () => {
    expect(buildTax1099Payload(baseInput(), 'production').test).toBe(false);
  });

  it('preSubmitCheck flags a bad recipient TIN but passes a clean payload', () => {
    expect(preSubmitCheck(buildTax1099Payload(baseInput(), 'sandbox'))).toHaveLength(0);
    const bad = baseInput();
    bad.records[0]!.recipient.tin = '12';
    expect(preSubmitCheck(buildTax1099Payload(bad, 'sandbox')).some((m) => /recipient TIN/.test(m))).toBe(true);
  });
});
