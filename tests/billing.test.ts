/**
 * Billing estimate: base fee once per form type, per-form × originals,
 * per-correction × corrected forms, flat mailing × paper mailings; cents only.
 */
import { describe, expect, it } from 'vitest';
import { computeFees, EMPTY_BILLING_SCHEDULE, netOfPercentFee, zBillingFees, type BillingSchedule } from '@vibe1099/shared';

const schedule: BillingSchedule = {
  base: { NEC: 2500, MISC: 2000, INT: 1500 },
  perForm: { NEC: 500, MISC: 400, INT: 300 },
  correction: { NEC: 1500 },
  mailing: 150,
};

describe('computeFees', () => {
  it('charges the base fee once per form type plus count × per-form rate', () => {
    const r = computeFees({ originals: { NEC: 10, INT: 2 }, corrections: {}, mailings: 0 }, schedule);
    expect(r.lines.map((l) => [l.formType, l.subtotal])).toEqual([
      ['NEC', 2500 + 10 * 500],
      ['INT', 1500 + 2 * 300],
    ]);
    expect(r.total).toBe(7500 + 2100);
  });

  it('adds corrections at the per-correction rate without changing the form count', () => {
    const r = computeFees({ originals: { NEC: 3 }, corrections: { NEC: 2 }, mailings: 0 }, schedule);
    const nec = r.lines[0]!;
    expect(nec.forms).toBe(3);
    expect(nec.correctionsFee).toBe(3000);
    expect(r.total).toBe(2500 + 1500 + 3000);
  });

  it('charges the base fee for a type with only corrections in the year', () => {
    const r = computeFees({ originals: {}, corrections: { NEC: 1 }, mailings: 0 }, schedule);
    expect(r.total).toBe(2500 + 1500);
  });

  it('prices every paper mailing at the flat rate', () => {
    const r = computeFees({ originals: { MISC: 4 }, corrections: {}, mailings: 5 }, schedule);
    expect(r.mailingFee).toBe(750);
    expect(r.total).toBe(2000 + 1600 + 750);
  });

  it('emits no line for a type with no billable activity', () => {
    const r = computeFees({ originals: { NEC: 0, DIV: 0 }, corrections: {}, mailings: 0 }, schedule);
    expect(r.lines).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('a type absent from the schedule bills $0', () => {
    const r = computeFees({ originals: { DIV: 7 }, corrections: {}, mailings: 0 }, schedule);
    expect(r.lines[0]!.subtotal).toBe(0);
  });

  it('a missing schedule computes $0 but still reports the counts', () => {
    const r = computeFees({ originals: { NEC: 4 }, corrections: { NEC: 1 }, mailings: 2 }, EMPTY_BILLING_SCHEDULE);
    expect(r.total).toBe(0);
    expect(r.lines[0]!.forms).toBe(4);
    expect(r.mailings).toBe(2);
  });
});

describe('percentage fee (net before the % fee)', () => {
  it('backs a 4% fee out of the total: $104 → net $100', () => {
    expect(netOfPercentFee(10400, 400)).toBe(10000);
    const r = computeFees({ originals: { NEC: 1 }, corrections: {}, mailings: 0 }, {
      ...EMPTY_BILLING_SCHEDULE, base: { NEC: 5400 }, perForm: { NEC: 5000 }, feePercentBp: 400,
    });
    expect([r.total, r.net, r.percentFee]).toEqual([10400, 10000, 400]);
  });

  it('rounds the net to the nearest cent and keeps net + fee = total', () => {
    // 100.00 / 1.04 = 96.1538… → 96.15
    const r = computeFees({ originals: { NEC: 1 }, corrections: {}, mailings: 0 }, {
      ...EMPTY_BILLING_SCHEDULE, base: { NEC: 10000 }, feePercentBp: 400,
    });
    expect(r.net).toBe(9615);
    expect(r.net + r.percentFee).toBe(r.total);
  });

  it('no percentage set → net equals total (older schedules without the field)', () => {
    const r = computeFees({ originals: { NEC: 2 }, corrections: {}, mailings: 0 }, schedule);
    expect(r.feePercentBp).toBe(0);
    expect(r.net).toBe(r.total);
  });

  it('supports fractional percentages (3.5%)', () => {
    expect(netOfPercentFee(10350, 350)).toBe(10000);
  });
});

describe('zBillingFees', () => {
  it('accepts a year-keyed schedule in integer cents', () => {
    expect(() => zBillingFees.parse({ '2026': schedule })).not.toThrow();
  });
  it.each([
    ['fractional cents', { '2026': { ...schedule, mailing: 1.5 } }],
    ['negative rate', { '2026': { ...schedule, base: { NEC: -1 } } }],
    ['unknown form type', { '2026': { ...schedule, perForm: { W2: 100 } } }],
    ['bad year key', { '26': schedule }],
    ['missing mailing', { '2026': { base: {}, perForm: {}, correction: {} } }],
    ['percentage over 100%', { '2026': { ...schedule, feePercentBp: 10001 } }],
    ['fractional basis points', { '2026': { ...schedule, feePercentBp: 4.5 } }],
  ])('rejects %s', (_label, value) => {
    expect(() => zBillingFees.parse(value)).toThrow();
  });
});
