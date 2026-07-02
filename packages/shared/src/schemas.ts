/**
 * Zod schemas shared between API and web — request payload validation.
 */
import { z } from 'zod';
import { FORM_TYPES } from './registry.js';

export const zTinType = z.enum(['SSN', 'EIN']);
export const zFormType = z.enum(FORM_TYPES);
export const zTaxYear = z.number().int().min(2020).max(2100);

export const zAddress = z.object({
  line1: z.string().min(1).max(120),
  line2: z.string().max(120).optional().default(''),
  city: z.string().min(1).max(60),
  state: z.string().length(2),
  zip: z.string().regex(/^\d{5}(-\d{4})?$/, 'ZIP must be 12345 or 12345-6789'),
});
export type Address = z.infer<typeof zAddress>;

export const zEmail = z.string().email().max(254);
export const zMobile = z
  .string()
  .transform((s) => s.replace(/[^\d+]/g, ''))
  .refine((s) => /^\+?1?\d{10}$/.test(s), 'Mobile must be a 10-digit US number');

export const zRecipientInput = z.object({
  tin: z.string().min(9).max(11),
  tinType: zTinType,
  name1: z.string().min(1).max(120),
  name2: z.string().max(120).optional().default(''),
  address: zAddress,
  email: zEmail.optional().nullable(),
  mobile: z.string().optional().nullable(),
  backupWithholding: z.boolean().optional().default(false),
});
export type RecipientInput = z.infer<typeof zRecipientInput>;

export const zPayerInput = z.object({
  legalName: z.string().min(1).max(120),
  dbaName: z.string().max(120).optional().default(''),
  tin: z.string().min(9).max(11),
  tinType: zTinType,
  address: zAddress,
  phone: z.string().max(20).optional().default(''),
  contactEmail: zEmail.optional().nullable(),
  contactMobile: z.string().optional().nullable(),
  moWithholdingId: z.string().max(14).optional().nullable(),
  moSourceDefault: z.boolean().optional().default(false),
});
export type PayerInput = z.infer<typeof zPayerInput>;

export const zFormRecordInput = z.object({
  payerId: z.string().uuid(),
  recipientId: z.string().uuid(),
  taxYear: zTaxYear,
  formType: zFormType,
  boxValues: z.record(z.union([z.number().int(), z.boolean(), z.string(), z.null()])),
  accountNumber: z.string().max(20).optional().default(''),
  secondTinNotice: z.boolean().optional().default(false),
  moSource: z.boolean().optional(),
  notes: z.string().max(2000).optional().default(''),
});
export type FormRecordInput = z.infer<typeof zFormRecordInput>;

export const zLoginInput = z.object({
  email: zEmail,
  password: z.string().min(1).max(200),
  totp: z.string().length(6).optional(),
});

export const zUserRole = z.enum(['admin', 'preparer', 'reviewer']);
export type UserRole = z.infer<typeof zUserRole>;

export const zClientInviteInput = z.object({
  payerId: z.string().uuid(),
  taxYear: zTaxYear,
  formTypes: z.array(zFormType).min(1),
  email: zEmail.optional().nullable(),
  mobile: z.string().optional().nullable(),
  expiresInDays: z.number().int().min(1).max(365).optional().default(30),
});

export const zW9RequestInput = z.object({
  recipientId: z.string().uuid().optional(),
  name: z.string().max(120).optional(),
  email: zEmail.optional().nullable(),
  mobile: z.string().optional().nullable(),
  payerId: z.string().uuid().optional(),
});

export const zW9SubmitInput = z.object({
  name: z.string().min(1).max(120),
  businessName: z.string().max(120).optional().default(''),
  taxClassification: z.enum([
    'individual',
    'c_corp',
    's_corp',
    'partnership',
    'trust_estate',
    'llc_c',
    'llc_s',
    'llc_p',
    'other',
  ]),
  otherClassification: z.string().max(120).optional().default(''),
  exemptPayeeCode: z.string().max(2).optional().default(''),
  fatcaExemptionCode: z.string().max(3).optional().default(''),
  address: zAddress,
  tin: z.string().min(9).max(11),
  tinConfirm: z.string().min(9).max(11),
  tinType: zTinType,
  signatureName: z.string().min(1).max(120),
  signatureKind: z.enum(['typed', 'drawn']),
  // drawn signature only — MUST be a base64 data URI. Rejecting other schemes
  // prevents SSRF / file:// reads when the value is rendered as <img src> by the
  // WeasyPrint sidecar (defense in depth with the render-side url_fetcher).
  signatureImage: z
    .string()
    .max(200_000)
    .regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/, 'signature image must be a base64 PNG/JPEG data URI')
    .optional()
    .nullable(),
  esignConsent: z.literal(true),
});
export type W9SubmitInput = z.infer<typeof zW9SubmitInput>;
