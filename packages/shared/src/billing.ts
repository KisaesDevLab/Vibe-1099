/**
 * Billing fee schedule + calculation — an internal estimate of what the firm
 * charges each payer for its 1099 work. Integer cents throughout (ADR-001).
 *
 * Per payer, per tax year, per form type:
 *   base fee            once when the payer has any billable activity in that type
 *   per-form fee        × non-draft ORIGINAL forms (rejected included, refiles not re-counted)
 *   per-correction fee  × corrected forms (a Type 2 zero+new pair is ONE correction)
 * plus a flat mailing fee × paper Copy B mailings actually sent (re-mails count).
 *
 * The schedule's rates already INCLUDE the firm's percentage fee (e.g. 4%), so
 * `total` is the gross; `net` backs it out (total ÷ 1.04) for entry into the
 * firm's billing system, which adds the percentage itself.
 */
import { z } from 'zod';
import { FORM_TYPES, type FormType } from './registry.js';

const zCents = z.number().int().min(0);
const zRateMap = z.record(z.enum(FORM_TYPES), zCents);

export const zBillingSchedule = z.object({
  base: zRateMap,
  perForm: zRateMap,
  correction: zRateMap,
  mailing: zCents,
  /** percentage fee included in the totals, in basis points (400 = 4.00%); absent = 0 */
  feePercentBp: z.number().int().min(0).max(10000).optional(),
});
export type BillingSchedule = z.infer<typeof zBillingSchedule>;

/** app_settings `billing_fees`: tax year ("2026") → schedule. */
export const zBillingFees = z.record(z.string().regex(/^\d{4}$/), zBillingSchedule);
export type BillingFees = z.infer<typeof zBillingFees>;

export const EMPTY_BILLING_SCHEDULE: BillingSchedule = { base: {}, perForm: {}, correction: {}, mailing: 0 };

export interface BillingCounts {
  /** non-draft original forms by type */
  originals: Partial<Record<FormType, number>>;
  /** corrected forms by (original) type */
  corrections: Partial<Record<FormType, number>>;
  /** paper Copy B mailings sent */
  mailings: number;
}

export interface BillingLine {
  formType: FormType;
  forms: number;
  baseFee: number;
  perFormRate: number;
  formsFee: number;
  corrections: number;
  correctionRate: number;
  correctionsFee: number;
  subtotal: number;
}

export interface BillingResult {
  lines: BillingLine[];
  mailings: number;
  mailingRate: number;
  mailingFee: number;
  /** gross: what the schedule's rates add up to (includes the percentage fee) */
  total: number;
  feePercentBp: number;
  /** total before the percentage fee, rounded to the cent */
  net: number;
  /** total − net */
  percentFee: number;
}

/** Back the percentage fee out of a gross amount: gross ÷ (1 + bp/10000), rounded half-up to the cent. */
export function netOfPercentFee(grossCents: number, feePercentBp: number): number {
  if (!feePercentBp) return grossCents;
  return Math.round((grossCents * 10000) / (10000 + feePercentBp));
}

export function computeFees(counts: BillingCounts, schedule: BillingSchedule): BillingResult {
  const lines: BillingLine[] = [];
  for (const formType of FORM_TYPES) {
    const forms = counts.originals[formType] ?? 0;
    const corrections = counts.corrections[formType] ?? 0;
    if (forms === 0 && corrections === 0) continue;
    const baseFee = schedule.base[formType] ?? 0;
    const perFormRate = schedule.perForm[formType] ?? 0;
    const correctionRate = schedule.correction[formType] ?? 0;
    const formsFee = forms * perFormRate;
    const correctionsFee = corrections * correctionRate;
    lines.push({
      formType,
      forms,
      baseFee,
      perFormRate,
      formsFee,
      corrections,
      correctionRate,
      correctionsFee,
      subtotal: baseFee + formsFee + correctionsFee,
    });
  }
  const mailingFee = counts.mailings * schedule.mailing;
  const total = lines.reduce((s, l) => s + l.subtotal, 0) + mailingFee;
  const feePercentBp = schedule.feePercentBp ?? 0;
  const net = netOfPercentFee(total, feePercentBp);
  return {
    lines,
    mailings: counts.mailings,
    mailingRate: schedule.mailing,
    mailingFee,
    total,
    feePercentBp,
    net,
    percentFee: total - net,
  };
}
