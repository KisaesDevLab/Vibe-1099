/**
 * Pub 1220 golden-file tests: record lengths, CR/LF, field positions asserted
 * against the documented layout (docs/mo-pub1220-layout.md), cents money
 * fields, K-record reconciliation, threshold filter.
 */
import { describe, expect, it } from 'vitest';
import { boxValuesToAmountCodes, buildMo1220File, meetsMoThreshold, nameControl, type Mo1220Input } from '@vibe1099/core/mo1220/writer';

function field(record: string, start: number, end: number): string {
  return record.slice(start - 1, end); // 1-based inclusive positions
}

const input: Mo1220Input = {
  taxYear: 2026,
  priorYear: false,
  transmitter: {
    tin: '43-1234567',
    name: 'Demo CPA Firm LLC',
    companyName: 'Demo CPA Firm LLC',
    address: '100 Main St',
    city: 'Kansas City',
    state: 'MO',
    zip: '64105',
    contactName: 'Demo Admin',
    contactPhone: '816-555-1234',
    contactEmail: 'admin@demo.firm',
  },
  groups: [
    {
      payer: {
        tin: '43-1111111',
        tinType: 'EIN',
        name: 'ACME CONSTRUCTION LLC',
        address: '200 Commerce Way',
        city: 'Kansas City',
        state: 'MO',
        zip: '64106',
        phone: '8165559876',
        moWithholdingId: '87654321',
      },
      formType: 'NEC',
      payees: [
        {
          recordId: 'r1',
          tin: '400111222',
          tinType: 'SSN',
          name1: 'JORDAN ABLE',
          name2: '',
          address: '101 Oak St',
          city: 'Kansas City',
          state: 'MO',
          zip: '64100',
          accountNumber: 'NEC2026-001',
          amounts: { '1': 1250000, '4': 50000 }, // $12,500.00 comp, $500.00 fed withheld
          stateTaxWithheldCents: 25000, // $250.00
        },
        {
          recordId: 'r2',
          tin: '451234567',
          tinType: 'EIN',
          name1: 'DELTA DRYWALL LLC',
          name2: '',
          address: '55 Pine Rd',
          city: 'Independence',
          state: 'MO',
          zip: '64050',
          accountNumber: '',
          amounts: { '1': 2200000 },
          stateTaxWithheldCents: 0,
        },
      ],
    },
  ],
};

describe('MO Pub 1220 writer — golden layout', () => {
  const out = buildMo1220File(input);
  const records = out.content.split('\r\n').filter(Boolean);
  const [t, a, b1, b2, c, k, f] = records as [string, string, string, string, string, string, string];

  it('file structure: T → A → B×2 → C → K → F, CRLF, 750 chars each', () => {
    expect(records).toHaveLength(7);
    expect(out.content.endsWith('\r\n')).toBe(true);
    for (const r of records) expect(r).toHaveLength(750);
    expect(records.map((r) => r[0]).join('')).toBe('TABBCKF');
    expect(out.recordCounts).toEqual({ t: 1, a: 1, b: 2, c: 1, k: 1, f: 1 });
  });

  it('records are uppercase ASCII', () => {
    for (const r of records) expect(r).toMatch(/^[\x20-\x7E]+$/);
    expect(out.content).not.toMatch(/[a-z]/);
  });

  it('T record: year, transmitter TIN, payee count, contact, sequence 1', () => {
    expect(field(t, 2, 5)).toBe('2026');
    expect(field(t, 7, 15)).toBe('431234567');
    expect(field(t, 296, 303)).toBe('00000002');
    expect(field(t, 304, 313)).toBe('DEMO ADMIN');
    expect(field(t, 500, 507)).toBe('00000001');
    expect(field(t, 518, 518)).toBe('I');
  });

  it('A record: payer TIN, type of return NE, amount codes, MO withholding ID', () => {
    expect(field(a, 2, 5)).toBe('2026');
    expect(field(a, 12, 20)).toBe('431111111');
    expect(field(a, 26, 27)).toBe('NE');
    expect(field(a, 28, 29)).toBe('14'); // NEC amount codes 1 + 4
    expect(field(a, 21, 24)).toBe('ACME'); // name control (EIN → first word)
    expect(field(a, 715, 722)).toBe('87654321');
    expect(field(a, 500, 507)).toBe('00000002');
  });

  it('B record: TIN type, TIN, CENTS money at fixed positions, state withholding, MO CF/SF code', () => {
    expect(field(b1, 2, 5)).toBe('2026');
    expect(field(b1, 11, 11)).toBe('2'); // SSN
    expect(field(b1, 12, 20)).toBe('400111222');
    expect(field(b1, 7, 10)).toBe('ABLE'); // SSN → last word
    expect(field(b1, 21, 40)).toBe('NEC2026-001'.padEnd(20));
    // payment amount 1 (positions 55-66): $12,500.00 => 1250000 cents, assumed decimal
    expect(field(b1, 55, 66)).toBe('000001250000');
    // payment amount 4 (positions 91-102): $500.00
    expect(field(b1, 91, 102)).toBe('000000050000');
    expect(field(b1, 288, 298)).toBe('JORDAN ABLE');
    // state income tax withheld 723-734
    expect(field(b1, 723, 734)).toBe('000000025000');
    expect(field(b1, 747, 748)).toBe('26'); // Missouri
    // second payee: EIN
    expect(field(b2, 11, 11)).toBe('1');
    expect(field(b2, 55, 66)).toBe('000002200000');
    expect(field(b2, 723, 734)).toBe(' '.repeat(12)); // no withholding → blank
  });

  it('C record: payee count + 18-char control totals per amount code', () => {
    expect(field(c, 2, 9)).toBe('00000002');
    // control total 1 at 16-33: 1250000 + 2200000 = 3450000 cents
    expect(field(c, 16, 33)).toBe('000000000003450000');
    // control total 4 (4th slot: 16 + 3*18 = 70..87): 50000
    expect(field(c, 70, 87)).toBe('000000000000050000');
  });

  it('K record: mirrors totals + MO state withholding reconciliation at 707-724', () => {
    expect(field(k, 2, 9)).toBe('00000002');
    expect(field(k, 16, 33)).toBe('000000000003450000');
    expect(field(k, 707, 724)).toBe('000000000000025000');
    expect(field(k, 745, 746)).toBe('26');
  });

  it('F record: A-record count + total payees', () => {
    expect(field(f, 2, 9)).toBe('00000001');
    expect(field(f, 50, 57)).toBe('00000002');
    expect(field(f, 500, 507)).toBe('00000007');
  });

  it('kTotals expose cents for the UI', () => {
    expect(out.kTotals['1']).toBe(3450000);
    expect(out.kTotals['stateTaxWithheld']).toBe(25000);
  });
});

describe('MO threshold + mapping helpers', () => {
  it('$1,200 threshold with withholding override', () => {
    expect(meetsMoThreshold({ '1': 119999 }, 0)).toBe(false);
    expect(meetsMoThreshold({ '1': 120000 }, 0)).toBe(true);
    expect(meetsMoThreshold({ '1': 100 }, 1)).toBe(true); // any withholding → reportable
  });

  it('maps box values to amount codes via registry', () => {
    const { amounts, stateTaxWithheldCents } = boxValuesToAmountCodes('NEC', 2026, {
      box1: 1250000,
      fedTaxWithheld: 50000,
      stateTaxWithheld: 25000,
      directSales: false,
    });
    expect(amounts).toEqual({ '1': 1250000, '4': 50000 });
    expect(stateTaxWithheldCents).toBe(25000);
  });

  it('name control heuristics', () => {
    expect(nameControl('JORDAN ABLE', 'SSN')).toBe('ABLE');
    expect(nameControl('ACME CONSTRUCTION LLC', 'EIN')).toBe('ACME');
    expect(nameControl('NG', 'SSN')).toBe('NG  ');
  });
});
