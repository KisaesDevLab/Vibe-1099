import { describe, expect, it } from 'vitest';
import {
  deadlinesFor,
  FORM_TYPES,
  getFormDef,
  listFormDefs,
  moAmountCodes,
  SUPPORTED_TAX_YEARS,
} from '@vibe1099/shared';

const CTX = { backupWithholding: false, secondTinNotice: false };

describe('form-type registry (form_type, tax_year)', () => {
  it('defines all four v1 form types for every supported year', () => {
    for (const ty of SUPPORTED_TAX_YEARS) {
      expect(listFormDefs(ty).map((d) => d.formType)).toEqual([...FORM_TYPES]);
    }
  });

  it('throws on unsupported year', () => {
    expect(() => getFormDef('NEC', 2019)).toThrow(/Unsupported/);
  });

  it('every cents box maps to an IRIS element', () => {
    for (const ty of SUPPORTED_TAX_YEARS) {
      for (const def of listFormDefs(ty)) {
        for (const box of def.boxes) {
          if (box.kind === 'cents') expect(box.irisElement, `${def.formType} ${box.id}`).toBeTruthy();
        }
      }
    }
  });

  it('derives MO amount codes sorted digits-then-letters', () => {
    const misc = getFormDef('MISC', 2026);
    const codes = moAmountCodes(misc);
    expect(codes).toMatch(/^[1-9]+[A-Z]*$/);
    expect(codes).toContain('1');
    expect(codes).toContain('C'); // gross proceeds to attorney
  });

  it('validates: empty form is an error', () => {
    const def = getFormDef('NEC', 2026);
    const issues = def.validate({}, CTX);
    expect(issues.some((i) => i.code === 'E_EMPTY_FORM' && i.severity === 'error')).toBe(true);
  });

  it('validates: negative amounts blocked', () => {
    const def = getFormDef('NEC', 2026);
    const issues = def.validate({ box1: -100 }, CTX);
    expect(issues.some((i) => i.code === 'E_NEGATIVE')).toBe(true);
  });

  it('validates: non-integer cents blocked', () => {
    const def = getFormDef('NEC', 2026);
    const issues = def.validate({ box1: 100.5 }, CTX);
    expect(issues.some((i) => i.code === 'E_NOT_CENTS')).toBe(true);
  });

  it('validates: NEC withholding without backup-withholding context warns', () => {
    const def = getFormDef('NEC', 2026);
    const issues = def.validate({ box1: 500000, fedTaxWithheld: 100000 }, CTX);
    expect(issues.some((i) => i.code === 'W_BACKUP_WH' && i.severity === 'warning')).toBe(true);
    const withCtx = def.validate({ box1: 500000, fedTaxWithheld: 100000 }, { ...CTX, backupWithholding: true });
    expect(withCtx.some((i) => i.code === 'W_BACKUP_WH')).toBe(false);
  });

  it('validates: state withholding requires payer state number + state code', () => {
    const def = getFormDef('NEC', 2026);
    const issues = def.validate({ box1: 500000, stateTaxWithheld: 10000 }, CTX);
    expect(issues.some((i) => i.code === 'E_STATE_ID_REQUIRED')).toBe(true);
    expect(issues.some((i) => i.code === 'E_STATE_CODE_REQUIRED')).toBe(true);
    const ok = def.validate(
      { box1: 500000, stateTaxWithheld: 10000, statePayerStateNo: '12345678', stateCode: 'MO' },
      CTX,
    );
    expect(ok.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('validates: TY2026 NEC under-threshold is a WARNING not a block', () => {
    const def = getFormDef('NEC', 2026);
    const issues = def.validate({ box1: 50000 }, CTX); // $500
    const warn = issues.find((i) => i.code === 'W_UNDER_THRESHOLD');
    expect(warn?.severity).toBe('warning');
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('validates: admin threshold override replaces the registry default', () => {
    const def = getFormDef('NEC', 2026);
    // $500 amount, override lowered to $400 → no warning
    const none = def.validate({ box1: 50000 }, { ...CTX, federalThresholdCents: 40000 });
    expect(none.some((i) => i.code === 'W_UNDER_THRESHOLD')).toBe(false);
    // override raised to $2,500 → warning fires and mentions the configured amount
    const warn = def.validate({ box1: 210000 }, { ...CTX, federalThresholdCents: 250000 });
    const issue = warn.find((i) => i.code === 'W_UNDER_THRESHOLD');
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toContain('2,500');
  });

  it('validates: DIV qualified cannot exceed ordinary', () => {
    const def = getFormDef('DIV', 2026);
    const issues = def.validate({ box1a: 100000, box1b: 200000 }, CTX);
    expect(issues.some((i) => i.code === 'E_QUAL_GT_ORD')).toBe(true);
  });

  it('deadlines: Jan 31 furnish, Mar 31 e-file, last day of Feb for MO (leap-aware)', () => {
    expect(deadlinesFor(2026)).toEqual({
      recipientFurnish: '2027-01-31',
      irsEfile: '2027-03-31',
      missouri: '2027-02-28',
    });
    expect(deadlinesFor(2027).missouri).toBe('2028-02-29'); // leap year
  });
});
