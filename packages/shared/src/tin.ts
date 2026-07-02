/**
 * TIN utilities — validation heuristics, normalization, masking.
 * Plaintext TIN is NEVER logged and NEVER appears in URLs.
 * All payee-facing output uses truncation: XXX-XX-1234 / XX-XXX1234.
 */

export type TinType = 'SSN' | 'EIN';

/** Strip to digits. */
export function normalizeTin(raw: string): string {
  return raw.replace(/\D/g, '');
}

export interface TinValidation {
  valid: boolean;
  tinType?: TinType;
  isItin?: boolean;
  reason?: string;
}

/**
 * Heuristic validation. `declaredType` comes from the entry form radio.
 * SSN rules: no 000/666/900-999 area, no 00 group, no 0000 serial.
 * ITIN detection: 9XX area with group 70-88, 90-92, 94-99 (valid for filing; flagged).
 */
export function validateTin(raw: string, declaredType: TinType): TinValidation {
  const tin = normalizeTin(raw);
  if (tin.length !== 9) return { valid: false, reason: 'TIN must be 9 digits' };
  if (/^(\d)\1{8}$/.test(tin)) return { valid: false, reason: 'TIN cannot be all one digit' };
  if (tin === '123456789' || tin === '987654321') {
    return { valid: false, reason: 'TIN is an obviously invalid sequence' };
  }

  if (declaredType === 'SSN') {
    const area = tin.slice(0, 3);
    const group = tin.slice(3, 5);
    const serial = tin.slice(5);
    if (group === '00') return { valid: false, reason: 'SSN group cannot be 00' };
    if (serial === '0000') return { valid: false, reason: 'SSN serial cannot be 0000' };
    if (area === '000') return { valid: false, reason: 'SSN area cannot be 000' };
    if (area === '666') return { valid: false, reason: 'SSN area cannot be 666' };
    if (area.startsWith('9')) {
      const g = parseInt(group, 10);
      const isItin = (g >= 70 && g <= 88) || (g >= 90 && g <= 92) || (g >= 94 && g <= 99);
      if (isItin) return { valid: true, tinType: 'SSN', isItin: true };
      return { valid: false, reason: 'SSN area cannot start with 9 (not a valid ITIN group)' };
    }
    return { valid: true, tinType: 'SSN', isItin: false };
  }

  // EIN: prefix cannot be 00, 07, 08, 09, 17, 18, 19, 28, 29, 49, 78, 79, 89 (unassigned campuses)
  const prefix = tin.slice(0, 2);
  const invalidPrefixes = new Set(['00', '07', '08', '09', '17', '18', '19', '28', '29', '49', '78', '79', '89']);
  if (invalidPrefixes.has(prefix)) return { valid: false, reason: `EIN prefix ${prefix} is not assigned` };
  return { valid: true, tinType: 'EIN' };
}

/** Payee-facing truncated display: XXX-XX-1234 (SSN/ITIN) or XX-XXX1234 (EIN). */
export function maskTin(tin: string, tinType: TinType): string {
  const last4 = normalizeTin(tin).slice(-4);
  return tinType === 'SSN' ? `XXX-XX-${last4}` : `XX-XXX${last4}`;
}

/** Full formatted TIN (payer TIN on forms is shown in full per Pub 1179). */
export function formatTin(tin: string, tinType: TinType): string {
  const t = normalizeTin(tin);
  return tinType === 'SSN' ? `${t.slice(0, 3)}-${t.slice(3, 5)}-${t.slice(5)}` : `${t.slice(0, 2)}-${t.slice(2)}`;
}

export function tinLast4(tin: string): string {
  return normalizeTin(tin).slice(-4);
}
