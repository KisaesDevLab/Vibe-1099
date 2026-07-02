/**
 * Money handling — INTEGER CENTS everywhere (ADR-001).
 * Deviation from suite whole-dollar convention: MO Pub 1220 money fields carry
 * cents with an assumed decimal, and IRIS XML carries decimal amounts.
 */

/** Parse user input like "1,234.56", "$1234.5", "1234" into integer cents. Throws on invalid. */
export function parseCents(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('Invalid amount');
    return Math.round(input * 100);
  }
  const cleaned = input.replace(/[$,\s]/g, '');
  if (cleaned === '' || cleaned === '-') return 0;
  if (!/^-?\d*(\.\d{0,2})?$/.test(cleaned)) throw new Error(`Invalid amount: ${input}`);
  const neg = cleaned.startsWith('-');
  const [wholeRaw = '0', fracRaw = ''] = cleaned.replace('-', '').split('.');
  const whole = wholeRaw === '' ? 0 : parseInt(wholeRaw, 10);
  const frac = parseInt((fracRaw + '00').slice(0, 2), 10);
  const cents = whole * 100 + frac;
  return neg ? -cents : cents;
}

/** Format cents as "1,234.56" (no currency symbol). */
export function formatCents(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  const frac = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/** Format cents as "$1,234.56". */
export function formatUsd(cents: number): string {
  return `$${formatCents(cents)}`;
}

/** Decimal string for IRIS XML: 123456 -> "1234.56". Never exponent, never grouping. */
export function centsToDecimalString(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Pub 1220 fixed-width money field: unsigned, right-justified, zero-filled,
 * cents with assumed decimal (no decimal point). Standard width is 12.
 */
export function centsToPub1220(cents: number, width = 12): string {
  if (cents < 0) throw new Error('Pub 1220 money fields are unsigned');
  const s = String(cents);
  if (s.length > width) throw new Error(`Amount overflows Pub 1220 field width ${width}: ${cents}`);
  return s.padStart(width, '0');
}

/** Sum an array of cents safely. */
export function sumCents(values: Array<number | null | undefined>): number {
  let total = 0;
  for (const v of values) total += v ?? 0;
  return total;
}
