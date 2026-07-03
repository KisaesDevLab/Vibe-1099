/**
 * TaxBandits (SPAN Enterprises) submission payload builder.
 *
 * Maps the provider-neutral transmission input (the same object IRIS/Tax1099
 * consume) into TaxBandits' Form1099 request model. TaxBandits is the transmitter
 * under their TCC, so the payload carries the Business (payer/issuer) + recipients
 * + box amounts; the firm is the account holder implied by the auth token.
 *
 * Field names follow the TaxBandits Form1099 request contract; the mapping is
 * centralized here so a live schema confirmation is a one-file change. Box ids come
 * from the shared form registry (box1, box2, box1a, …) so NEC/MISC/INT/DIV map
 * generically. PayerRef/PayeeRef carry our ULIDs for idempotency + linkage.
 */
import { centsToDecimalString } from '@vibe1099/shared';
import type { IrisTransmissionInput, IrisFormRecord } from '../iris/xml.js';

export interface TaxBanditsRecord {
  payeeRef: string; // our form_record id — echoed on status for per-record results
  formType: string; // NEC | MISC | INT | DIV
  taxYear: number;
  corrected: boolean;
  accountNumber?: string;
  secondTinNotice?: boolean;
  recipient: {
    tin: string;
    tinType: 'SSN' | 'EIN';
    name: string;
    name2?: string;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    zip: string;
  };
  amounts: Record<string, string>; // box id -> decimal string (cents fields)
  flags: Record<string, boolean>; // box id -> true (checkbox fields)
  text: Record<string, string>; // box id -> string (code/text fields)
  stateAmounts: Record<string, string>; // state box id -> decimal string
  /** Delivery add-ons (opt-in, billed) — pressure-seal paper remains primary. */
  postalMailing: boolean;
  onlineAccess: boolean;
}

export interface TaxBanditsPayload {
  submissionRef: string; // idempotency id (stored as transmissions.utid)
  taxYear: number;
  environment: 'sandbox' | 'production';
  isTestMode: boolean;
  isCorrection: boolean;
  business: {
    payerRef: string;
    tin: string;
    tinType: 'SSN' | 'EIN';
    name: string;
    dbaName?: string;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    zip: string;
    phone?: string;
  };
  // states TaxBandits should file via CF/SF where elected
  combinedFederalState: string[];
  records: TaxBanditsRecord[];
}

export interface TaxBanditsDeliveryOptions {
  postalMailing?: boolean;
  onlineAccess?: boolean;
}

function recordToTaxBandits(rec: IrisFormRecord, delivery: TaxBanditsDeliveryOptions): TaxBanditsRecord {
  const amounts: Record<string, string> = {};
  const flags: Record<string, boolean> = {};
  const text: Record<string, string> = {};
  const stateAmounts: Record<string, string> = {};
  for (const [boxId, v] of Object.entries(rec.boxValues)) {
    if (typeof v === 'number' && (v > 0 || rec.corrected)) {
      if (/^state/i.test(boxId)) stateAmounts[boxId] = centsToDecimalString(v);
      else amounts[boxId] = centsToDecimalString(v);
    } else if (v === true) {
      flags[boxId] = true;
    } else if (typeof v === 'string' && v !== '') {
      text[boxId] = v;
    }
  }
  return {
    payeeRef: rec.recordId,
    formType: rec.formType,
    taxYear: rec.taxYear,
    corrected: !!rec.corrected,
    accountNumber: rec.accountNumber,
    secondTinNotice: rec.secondTinNotice,
    recipient: {
      tin: rec.recipient.tin,
      tinType: rec.recipient.tinType,
      name: rec.recipient.name1,
      name2: rec.recipient.name2,
      address1: rec.recipient.address.line1,
      address2: rec.recipient.address.line2,
      city: rec.recipient.address.city,
      state: rec.recipient.address.state,
      zip: rec.recipient.address.zip,
    },
    amounts,
    flags,
    text,
    stateAmounts,
    // Pressure-seal paper remains primary (core plan Phase 9); these are opt-in.
    postalMailing: !!delivery.postalMailing,
    onlineAccess: !!delivery.onlineAccess,
  };
}

export function buildTaxBanditsPayload(
  input: IrisTransmissionInput,
  environment: 'sandbox' | 'production',
  delivery: TaxBanditsDeliveryOptions = {},
): TaxBanditsPayload {
  return {
    submissionRef: input.utid,
    taxYear: input.taxYear,
    environment,
    isTestMode: environment === 'sandbox',
    isCorrection: input.isCorrection,
    business: {
      payerRef: input.issuer.tin, // stable per-payer ref; the sync layer maps to BusinessId
      tin: input.issuer.tin,
      tinType: input.issuer.tinType,
      name: input.issuer.name1,
      dbaName: input.issuer.name2,
      address1: input.issuer.address.line1,
      address2: input.issuer.address.line2,
      city: input.issuer.address.city,
      state: input.issuer.address.state,
      zip: input.issuer.address.zip,
      phone: input.issuer.phone,
    },
    combinedFederalState: input.cfsfStates,
    records: input.records.map((r) => recordToTaxBandits(r, delivery)),
  };
}

/** Provider-neutral pre-submit checks (no TCC required — TaxBandits holds it). */
export function preSubmitCheckTaxBandits(payload: TaxBanditsPayload): string[] {
  const problems: string[] = [];
  if (!payload.records.length) problems.push('No records in submission');
  if (!/^\d{9}$/.test(payload.business.tin)) problems.push('Payer TIN is not 9 digits');
  for (const r of payload.records) {
    if (!/^\d{9}$/.test(r.recipient.tin)) problems.push(`Record ${r.payeeRef}: recipient TIN is not 9 digits`);
    if (!r.recipient.name) problems.push(`Record ${r.payeeRef}: recipient name missing`);
    if (!r.recipient.zip) problems.push(`Record ${r.payeeRef}: recipient ZIP missing`);
  }
  return problems;
}
