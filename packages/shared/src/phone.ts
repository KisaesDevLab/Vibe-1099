/**
 * US phone normalization for filing payloads. IRIS PhoneNum, TaxBandits Phone and
 * Tax1099 phone are 10-digit numeric fields: a stored "+1 (816) 555-9876" must
 * become "8165559876" — never a blind first-10-digits slice (which keeps the
 * country code and drops the last real digit).
 */
export function normalizeUsPhone(raw: string | null | undefined): string {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits.length === 10 ? digits : '';
}
