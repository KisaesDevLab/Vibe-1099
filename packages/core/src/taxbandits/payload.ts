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

// ---------------------------------------------------------------------------
// Wire format (developer.taxbandits.com, v1.7.3): the Create endpoints require
// { SubmissionManifest, ReturnHeader: { Business }, ReturnData: [...] } with
// per-form <FT>FormData box names. Confirmed live 2026-08-13 — omitting
// ReturnHeader returns F01-100064 "ReturnHeader should not be null".
// ---------------------------------------------------------------------------

type WireFormType = 'NEC' | 'MISC' | 'INT' | 'DIV';

/** Our registry box id → TaxBandits FormData amount field, per form. */
const WIRE_AMOUNTS: Record<WireFormType, Record<string, string>> = {
  NEC: { box1: 'B1NEC', fedTaxWithheld: 'B4FedTaxWH' },
  MISC: {
    box1: 'B1Rents', box2: 'B2Royalties', box3: 'B3OtherIncome', fedTaxWithheld: 'B4FedIncomeTaxWH',
    box5: 'B5FishingBoatProceeds', box6: 'B6MedHealthcarePymts', box8: 'B8SubstitutePymts',
    box9: 'B9CropInsurance', box10: 'B10GrossProceeds', box11: 'B11FishPurForResale',
    box12: 'B12Sec409ADeferrals', box14: 'B14EPP', box15: 'B15NonQualDefComp',
  },
  INT: {
    box1: 'B1IntIncome', box2: 'B2EarlyWithdrawPenalty', box3: 'B3InterestOnUS', fedTaxWithheld: 'B4FedIncomeTaxWH',
    box5: 'B5InvestExp', box6: 'B6ForeignTaxPaid', box8: 'B8TaxExemptInterest', box9: 'B9BondInterest',
    box10: 'B10MarketDiscount', box11: 'B11BondPre', box12: 'B12BondPreOnTreasOblig', box13: 'B13BondPreOnTaxExempt',
  },
  DIV: {
    box1a: 'B1aTotOrdiDiv', box1b: 'B1bQualiDiv', box2a: 'B2aTotCapGain', box2b: 'B2bUnRecapSecGain',
    box2c: 'B2cSec1202Gain', box2d: 'B2dCollGain', box2e: 'B2eSec897OrdiDiv', box2f: 'B2fSec897CapGain',
    box3: 'B3NonDivDist', fedTaxWithheld: 'B4FedIncTaxWH', box5: 'B5Sec199ADiv', box6: 'B6InvestExp',
    box7: 'B7ForeignTaxPaid', box9: 'B9CashLiquiDist', box10: 'B10NonCashLiquiDist',
    box12: 'B12ExemptIntDiv', box13: 'B13SpeciPrivActiBondIntDiv',
  },
};

const WIRE_FLAGS: Record<WireFormType, Record<string, string>> = {
  NEC: { directSales: 'B2IsDirectSales' },
  MISC: { directSales: 'B7IsDirectSale', fatca: 'B13IsFATCA' },
  INT: { fatca: 'IsFATCA' },
  DIV: { fatca: 'B11IsFATCA' },
};

const WIRE_TEXT: Record<WireFormType, Record<string, string>> = {
  NEC: {},
  MISC: {},
  INT: { box7: 'B7ForeignCountry', box14: 'B14CUSIPno' },
  DIV: { box8: 'B8ForeignCountryOrUsPoss' },
};

/** Fields their validator requires even when zero. */
const WIRE_REQUIRED_ZERO: Record<WireFormType, string[]> = {
  NEC: ['B1NEC', 'B4FedTaxWH'],
  MISC: [],
  INT: [],
  DIV: [],
};

const digits = (s: string | undefined): string => (s ?? '').replace(/\D/g, '');

function formatWireTin(tin: string, tinType: 'SSN' | 'EIN'): string {
  const d = digits(tin);
  if (d.length !== 9) return d;
  return tinType === 'EIN' ? `${d.slice(0, 2)}-${d.slice(2)}` : `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}

const NAME_SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV', 'V']);

/** "John Q Wormington JR" → FirstNm/LastNm/Suffix (their SSN-party required shape). */
function splitPersonName(full: string): { first: string; last: string; suffix?: string } {
  const parts = full.trim().split(/\s+/);
  let suffix: string | undefined;
  if (parts.length > 2 && NAME_SUFFIXES.has(parts[parts.length - 1]!.toUpperCase().replace(/\./g, ''))) {
    suffix = parts.pop();
  }
  if (parts.length === 1) return { first: parts[0]!, last: parts[0]!, suffix };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1]!, suffix };
}

function wireAddress(a: { address1: string; address2?: string; city: string; state: string; zip: string }): Record<string, unknown> {
  return {
    Address1: a.address1,
    ...(a.address2 ? { Address2: a.address2 } : {}),
    City: a.city,
    State: a.state,
    ZipCd: a.zip,
  };
}

/**
 * Convert the stored provider-neutral payload into TaxBandits' Create request
 * body. The submission must be a single form type (their Create endpoints are
 * per-form); composeTransmission enforces this for taxbandits transmissions.
 */
export function toTaxBanditsWire(payload: TaxBanditsPayload): Record<string, unknown> {
  const types = [...new Set(payload.records.map((r) => r.formType))];
  if (types.length !== 1 || !(types[0]! in WIRE_AMOUNTS)) {
    throw new Error(`TaxBandits requires a single supported form type per submission (got: ${types.join(', ') || 'none'})`);
  }
  const ft = types[0] as WireFormType;

  const returnData = payload.records.map((rec, i) => {
    const formData: Record<string, unknown> = {};
    for (const [boxId, val] of Object.entries(rec.amounts)) {
      const key = WIRE_AMOUNTS[ft][boxId];
      if (key) formData[key] = Number(val);
    }
    for (const boxId of Object.keys(rec.flags)) {
      const key = WIRE_FLAGS[ft][boxId];
      if (key) formData[key] = true;
    }
    for (const [boxId, val] of Object.entries(rec.text)) {
      const key = WIRE_TEXT[ft][boxId];
      if (key) formData[key] = val;
    }
    for (const req of WIRE_REQUIRED_ZERO[ft]) {
      if (formData[req] === undefined) formData[req] = 0;
    }
    if (rec.accountNumber) formData['AccountNum'] = rec.accountNumber;
    formData['Is2ndTINnot'] = !!rec.secondTinNotice;

    const stateCd = rec.text['stateCode'];
    const stateWH = rec.stateAmounts['stateTaxWithheld'];
    const stateIncome = rec.stateAmounts['stateIncome'];
    if (stateCd || stateWH || stateIncome) {
      formData['States'] = [
        {
          ...(stateCd ? { StateCd: stateCd } : {}),
          ...(rec.text['statePayerStateNo'] ? { StateIdNum: rec.text['statePayerStateNo'] } : {}),
          StateWH: Number(stateWH ?? '0'),
          ...(stateIncome ? { StateIncome: Number(stateIncome) } : {}),
        },
      ];
    }

    const r = rec.recipient;
    const recipient: Record<string, unknown> = {
      TINType: r.tinType,
      TIN: formatWireTin(r.tin, r.tinType),
      PayeeRef: rec.payeeRef,
      IsForeign: false,
      USAddress: wireAddress(r),
    };
    if (r.tinType === 'EIN') {
      recipient['FirstPayeeNm'] = r.name;
      if (r.name2) recipient['SecondPayeeNm'] = r.name2;
    } else {
      const n = splitPersonName(r.name);
      recipient['FirstNm'] = n.first;
      recipient['LastNm'] = n.last;
      if (n.suffix) recipient['Suffix'] = n.suffix;
      if (r.name2) recipient['SecondPayeeNm'] = r.name2;
    }

    return {
      SequenceId: String(i + 1),
      IsPostal: rec.postalMailing,
      IsOnlineAccess: rec.onlineAccess,
      Recipient: recipient,
      [`${ft}FormData`]: formData,
    };
  });

  const b = payload.business;
  const business: Record<string, unknown> = {
    BusinessNm: b.name,
    ...(b.dbaName ? { TradeNm: b.dbaName } : {}),
    PayerRef: b.payerRef,
    IsEIN: b.tinType === 'EIN',
    EINorSSN: formatWireTin(b.tin, b.tinType),
    ...(digits(b.phone) ? { Phone: digits(b.phone).slice(0, 10) } : {}),
    IsForeign: false,
    USAddress: wireAddress(b),
  };
  if (b.tinType === 'SSN') {
    const n = splitPersonName(b.name);
    business['FirstNm'] = n.first;
    business['LastNm'] = n.last;
    if (n.suffix) business['Suffix'] = n.suffix;
  }

  // State filing is declared ONLY when a record actually carries a state block.
  // It must not key off the CF/SF election list: that list is global (every
  // participating state, independent of these records), so including it made
  // every submission claim state filing even with no state data at all —
  // risking add-on charges and provider validation rejections.
  const anyStates = returnData.some((rd) => (rd[`${ft}FormData`] as Record<string, unknown>)['States'] !== undefined);
  return {
    SubmissionManifest: {
      TaxYear: String(payload.taxYear),
      IRSFilingType: 'IRIS',
      IsFederalFiling: true,
      IsStateFiling: anyStates,
      IsPostal: payload.records.some((r) => r.postalMailing),
      IsOnlineAccess: payload.records.some((r) => r.onlineAccess),
      IsScheduleFiling: false,
    },
    ReturnHeader: { Business: business },
    ReturnData: returnData,
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
