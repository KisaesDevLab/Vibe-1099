import { describe, expect, it } from 'vitest';
import { maskTin, normalizeTin, tinLast4, validateTin } from '@vibe1099/shared';

describe('TIN validation heuristics', () => {
  it('accepts valid SSNs', () => {
    expect(validateTin('400-11-1222', 'SSN')).toMatchObject({ valid: true, isItin: false });
  });
  it('rejects invalid SSN patterns', () => {
    expect(validateTin('000-11-1222', 'SSN').valid).toBe(false); // 000 area
    expect(validateTin('666-11-1222', 'SSN').valid).toBe(false); // 666 area
    expect(validateTin('400-00-1222', 'SSN').valid).toBe(false); // 00 group
    expect(validateTin('400-11-0000', 'SSN').valid).toBe(false); // 0000 serial
    expect(validateTin('111111111', 'SSN').valid).toBe(false); // repeated digit
    expect(validateTin('123456789', 'SSN').valid).toBe(false); // sequence
    expect(validateTin('12345678', 'SSN').valid).toBe(false); // 8 digits
  });
  it('detects ITINs (9xx area, valid group)', () => {
    expect(validateTin('912-70-1234', 'SSN')).toMatchObject({ valid: true, isItin: true });
    expect(validateTin('912-89-1234', 'SSN').valid).toBe(false); // group 89 not ITIN
  });
  it('rejects unassigned EIN prefixes', () => {
    expect(validateTin('07-1234567', 'EIN').valid).toBe(false);
    expect(validateTin('45-1234567', 'EIN').valid).toBe(true);
  });
  it('masks for payee-facing output', () => {
    expect(maskTin('400111222', 'SSN')).toBe('XXX-XX-1222');
    expect(maskTin('451234567', 'EIN')).toBe('XX-XXX4567');
  });
  it('normalizes and slices', () => {
    expect(normalizeTin('45-123 4567')).toBe('451234567');
    expect(tinLast4('400-11-1222')).toBe('1222');
  });
});
