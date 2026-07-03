/**
 * Tax1099 (Zenwork) submission payload builder.
 *
 * Maps the provider-neutral transmission input (the same object IRIS consumes)
 * into Tax1099's JSON form model. Because Tax1099 is the transmitter, the
 * payload carries the PAYER (issuer) + recipients + box amounts; the firm is the
 * account holder implied by the API key, not part of the form data.
 *
 * NOTE: field names below follow Tax1099's documented form model shape. The
 * exact wire schema is finalized against the Developer Hub (developer.tax1099.com)
 * contract; keeping the mapping centralized here means only THIS file changes
 * when the live schema is confirmed. Box ids come straight from the shared form
 * registry (box1, box2, box1a, …) so NEC/MISC/INT/DIV all map generically.
 */
import { centsToDecimalString } from '@vibe1099/shared';
import type { IrisTransmissionInput, IrisFormRecord } from '../iris/xml.js';

export interface Tax1099Form {
  refId: string; // our form_record id — echoed back on status for per-record results
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
}

export interface Tax1099Payload {
  submissionRef: string; // our idempotency id (stored as transmissions.utid)
  taxYear: number;
  environment: 'sandbox' | 'production';
  test: boolean;
  isCorrection: boolean;
  payer: {
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
  // ask Tax1099 to also file participating states via CF/SF where elected
  combinedFederalState: string[];
  forms: Tax1099Form[];
}

function formToTax1099(rec: IrisFormRecord): Tax1099Form {
  const amounts: Record<string, string> = {};
  const flags: Record<string, boolean> = {};
  const text: Record<string, string> = {};
  const stateAmounts: Record<string, string> = {};
  for (const [boxId, v] of Object.entries(rec.boxValues)) {
    if (typeof v === 'number' && (v > 0 || rec.corrected)) {
      // state boxes carry a stateTax*/state* prefix in the registry ids
      if (/^state/i.test(boxId)) stateAmounts[boxId] = centsToDecimalString(v);
      else amounts[boxId] = centsToDecimalString(v);
    } else if (v === true) {
      flags[boxId] = true;
    } else if (typeof v === 'string' && v !== '') {
      text[boxId] = v;
    }
  }
  return {
    refId: rec.recordId,
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
  };
}

export function buildTax1099Payload(
  input: IrisTransmissionInput,
  environment: 'sandbox' | 'production',
): Tax1099Payload {
  return {
    submissionRef: input.utid,
    taxYear: input.taxYear,
    environment,
    test: environment === 'sandbox',
    isCorrection: input.isCorrection,
    payer: {
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
    forms: input.records.map(formToTax1099),
  };
}

/** Lightweight pre-submit checks (provider-neutral subset — no TCC required). */
export function preSubmitCheck(payload: Tax1099Payload): string[] {
  const problems: string[] = [];
  if (!payload.forms.length) problems.push('No records in submission');
  if (!/^\d{9}$/.test(payload.payer.tin)) problems.push('Payer TIN is not 9 digits');
  for (const f of payload.forms) {
    if (!/^\d{9}$/.test(f.recipient.tin)) problems.push(`Record ${f.refId}: recipient TIN is not 9 digits`);
    if (!f.recipient.name) problems.push(`Record ${f.refId}: recipient name missing`);
    if (!f.recipient.zip) problems.push(`Record ${f.refId}: recipient ZIP missing`);
  }
  return problems;
}
