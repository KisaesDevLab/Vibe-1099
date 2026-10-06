/**
 * Billing fee schedule + calculation — an internal estimate of what the firm
 * charges each payer for its 1099 work. Integer cents throughout (ADR-001).
 *
 * Per payer, per tax year, per form type:
 *   base fee            once when the payer has any billable activity in that type
 *   per-form fee        × non-draft ORIGINAL forms (rejected included, refiles not re-counted)
 *   per-correction fee  × corrected forms (a Type 2 zero+new pair is ONE correction)
 * plus a flat mailing fee × paper Copy B mailings actually sent (re-mails count).
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
  total: number;
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
  return {
    lines,
    mailings: counts.mailings,
    mailingRate: schedule.mailing,
    mailingFee,
    total: lines.reduce((s, l) => s + l.subtotal, 0) + mailingFee,
  };
}
