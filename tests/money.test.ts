import { describe, expect, it } from 'vitest';
import { centsToDecimalString, centsToPub1220, formatCents, parseCents, sumCents } from '@vibe1099/shared';

describe('money — integer cents (ADR-001)', () => {
  it('parses user input to cents', () => {
    expect(parseCents('1,234.56')).toBe(123456);
    expect(parseCents('$1234.5')).toBe(123450);
    expect(parseCents('1234')).toBe(123400);
    expect(parseCents('0.01')).toBe(1);
    expect(parseCents('')).toBe(0);
    expect(parseCents(12.34)).toBe(1234);
  });

  it('rejects invalid amounts', () => {
    expect(() => parseCents('12.345')).toThrow();
    expect(() => parseCents('abc')).toThrow();
    expect(() => parseCents(Number.NaN)).toThrow();
  });

  it('formats cents', () => {
    expect(formatCents(123456)).toBe('1,234.56');
    expect(formatCents(5)).toBe('0.05');
    expect(formatCents(-987654321)).toBe('-9,876,543.21');
  });

  it('IRIS decimal strings never lose cents', () => {
    expect(centsToDecimalString(123456)).toBe('1234.56');
    expect(centsToDecimalString(100)).toBe('1.00');
    expect(centsToDecimalString(1)).toBe('0.01');
  });

  it('Pub 1220 money fields: cents, assumed decimal, right-justified zero-fill', () => {
    expect(centsToPub1220(123456)).toBe('000000123456');
    expect(centsToPub1220(0)).toBe('000000000000');
    expect(centsToPub1220(1, 18)).toBe('000000000000000001');
    expect(() => centsToPub1220(-5)).toThrow(/unsigned/);
    expect(() => centsToPub1220(10 ** 13)).toThrow(/overflow/i);
  });

  it('sums with nulls', () => {
    expect(sumCents([100, null, undefined, 50])).toBe(150);
  });
});
