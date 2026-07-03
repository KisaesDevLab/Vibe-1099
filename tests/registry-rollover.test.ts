import { describe, expect, it } from 'vitest';
import { getFormDef, listFormDefs, isSupportedYear, MAX_TAX_YEAR } from '@vibe1099/shared';

describe('registry rollover — new filing years build on demand', () => {
  it('builds a not-shipped year (2027) from the parameterized layouts', () => {
    const nec = getFormDef('NEC', 2027);
    expect(nec.taxYear).toBe(2027);
    expect(nec.formType).toBe('NEC');
    // TY>=2026 threshold branch (OBBBA $2,000) applies to rolled-forward years
    expect(nec.federalThresholdCents).toBe(200000);
    expect(listFormDefs(2027)).toHaveLength(4);
  });

  it('accepts in-range years and rejects out-of-range', () => {
    expect(isSupportedYear(2027)).toBe(true);
    expect(isSupportedYear(2019)).toBe(false);
    expect(() => getFormDef('MISC', MAX_TAX_YEAR + 1)).toThrow(/Unsupported/);
  });
});
