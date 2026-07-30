/**
 * TaxBandits (SPAN Enterprises) Form1099 submission payload builder.
 *
 * Emits the REAL TaxBandits Form1099<TYPE>/Create request envelope
 * (SubmissionManifest / ReturnHeader.Business / ReturnData[].{Recipient,<TYPE>FormData}),
 * mapping the provider-neutral transmission input (the same object IRIS/Tax1099
 * consume) into TaxBandits' PascalCase model. TaxBandits is the transmitter under
 * their TCC, so the payload carries the Business (payer) + recipients + box amounts;
 * the firm is the account holder implied by the auth token.
 *
 * IMPORTANT — one form type per submission. Each 1099 form has its OWN
 * Create/Status/Correction endpoint and a form-specific FormData object, so a
 * TaxBandits submission MUST be homogeneous. `buildTaxBanditsPayload` derives the
 * single form type from the records and throws if they are mixed; the compose flow
 * enforces the same invariant before it ever gets here.
 *
 * The per-form box→field maps below (BOX_FIELD_MAP) are the one place a live-schema
 * confirmation lands: TaxBandits' FormData property names (B1NEC, B1Rents, …) are
 * centralized here so reconciling against the sandbox is a table edit, not a code
 * change. Box ids come from the shared form registry.
 */
import { AppError, ErrorCodes } from '@vibe1099/shared';
import type { FormType } from '@vibe1099/shared';
import type { IrisTransmissionInput, IrisFormRecord, IrisParty } from '../iris/xml.js';

export type TaxBanditsFormType = 'NEC' | 'MISC' | 'INT' | 'DIV';

const SUPPORTED: readonly TaxBanditsFormType[] = ['NEC', 'MISC', 'INT', 'DIV'];

export function isTaxBanditsFormType(t: string): t is TaxBanditsFormType {
  return (SUPPORTED as readonly string[]).includes(t);
}

/**
 * Registry box id → TaxBandits FormData property name, per form type. Amount boxes
 * become numbers; checkbox boxes become booleans; string boxes pass through.
 * State withholding is handled separately (the `States` array), so state box ids
 * are intentionally absent here.
 *
 * VERIFY against the live TaxBandits sandbox before production wire-up: the field
 * names follow the published Form1099 request reference, but SPAN occasionally
 * revises property spellings between API versions.
 */
const BOX_FIELD_MAP: Record<TaxBanditsFormType, Record<string, string>> = {
  NEC: {
    box1: 'B1NEC',
    directSales: 'B2DirectSalesInd',
    fedTaxWithheld: 'B4FedTaxWH',
  },
  MISC: {
    box1: 'B1Rents',
    box2: 'B2Royalties',
    box3: 'B3OtherIncome',
    fedTaxWithheld: 'B4FedTaxWH',
    box5: 'B5FishingBoatProceeds',
    box6: 'B6MedHealthCarePymt',
    directSales: 'B7DirectSalesInd',
    box8: 'B8SubstitutePymtsInLieuOfDividends',
    box9: 'B9CropInsuranceProceeds',
    box10: 'B10GrossProceedsPaidToAttorney',
    box11: 'B11FishPurchasedForResale',
    box12: 'B12Sec409ADeferrals',
    fatca: 'FatcaFilingRequirementInd',
    box14: 'B14ExcessGoldenParachutePymt',
    box15: 'B15NonqualifiedDeferredCompensation',
  },
  INT: {
    box1: 'B1IntIncome',
    box2: 'B2EarlyWithdrawalPenalty',
    box3: 'B3IntOnUSSavingsBondsAndTreasuryOblig',
    fedTaxWithheld: 'B4FedTaxWH',
    box5: 'B5InvestmentExpenses',
    box6: 'B6ForeignTaxPaid',
    box7: 'B7ForeignCountry',
    box8: 'B8TaxExemptInterest',
    box9: 'B9SpecifiedPrivateActivityBondInterest',
    box10: 'B10MarketDiscount',
    box11: 'B11BondPremium',
    box12: 'B12BondPremiumOnTreasuryOblig',
    box13: 'B13BondPremiumOnTaxExemptBond',
    fatca: 'FatcaFilingRequirementInd',
    box14: 'B14TaxExemptBondCUSIPNo',
  },
  DIV: {
    box1a: 'B1aTotalOrdinaryDividends',
    box1b: 'B1bQualifiedDividends',
    box2a: 'B2aTotalCapitalGainDistr',
    box2b: 'B2bUnrecapSec1250Gain',
    box2c: 'B2cSection1202Gain',
    box2d: 'B2dCollectibles28PercentGain',
    box2e: 'B2eSection897OrdinaryDividends',
    box2f: 'B2fSection897CapitalGain',
    box3: 'B3NondividendDistributions',
    fedTaxWithheld: 'B4FedTaxWH',
    box5: 'B5Section199ADividends',
    box6: 'B6InvestmentExpenses',
    box7: 'B7ForeignTaxPaid',
    box8: 'B8ForeignCountry',
    box9: 'B9CashLiquidationDistr',
    box10: 'B10NoncashLiquidationDistr',
    fatca: 'FatcaFilingRequirementInd',
    box12: 'B12ExemptInterestDividends',
    box13: 'B13SpecifiedPrivateActivityBondInterestDividends',
  },
};

// --- Real TaxBandits request envelope types ---------------------------------

export interface TbUSAddress {
  Address1: string;
  Address2?: string;
  City: string;
  State: string;
  ZipCd: string;
}

export interface TbBusiness {
  BusinessNm: string;
  TradeNm?: string;
  IsEIN: boolean;
  EINorSSN: string;
  Phone?: string;
  IsForeign: boolean;
  USAddress: TbUSAddress;
}

export interface TbRecipient {
  RecipientId: string | null;
  TINType: 'SSN' | 'EIN';
  TIN: string;
  FirstPayeeNm: string;
  SecondPayeeNm?: string;
  IsForeign: boolean;
  USAddress: TbUSAddress;
}

export interface TbStateInfo {
  StateCd: string;
  StateIdNum?: string;
  StateWHAmt?: number;
  StateIncomeAmt?: number;
}

/** ReturnData row: recipient + the form-specific FormData object (NECFormData, …). */
export interface TbReturnDataItem {
  SequenceId: string; // our form_record id — echoed on status for per-record results
  RecordId: string | null;
  Recipient: TbRecipient;
  // exactly one of these is present, keyed by form type
  NECFormData?: Record<string, unknown>;
  MISCFormData?: Record<string, unknown>;
  INTFormData?: Record<string, unknown>;
  DIVFormData?: Record<string, unknown>;
}

export interface TbSubmissionManifest {
  SubmissionId: string | null;
  TaxYear: string;
  IsFederalFiling: boolean;
  IsStateFiling: boolean;
  IsPostal: boolean;
  IsOnlineAccess: boolean;
  IsScheduleFiling: boolean;
}

export interface TaxBanditsCreateRequest {
  /** form type this submission targets — drives endpoint selection, NOT serialized. */
  formType: TaxBanditsFormType;
  SubmissionManifest: TbSubmissionManifest;
  ReturnHeader: { Business: TbBusiness };
  ReturnData: TbReturnDataItem[];
}

export interface TaxBanditsDeliveryOptions {
  postalMailing?: boolean;
  onlineAccess?: boolean;
}

// --- Builders ----------------------------------------------------------------

/** integer cents → JSON number with 2-dp precision (e.g. 123456 → 1234.56). */
function centsToNumber(cents: number): number {
  return Math.round(cents) / 100;
}

function usAddress(p: IrisParty): TbUSAddress {
  return {
    Address1: p.address.line1,
    Address2: p.address.line2 || undefined,
    City: p.address.city,
    State: p.address.state,
    ZipCd: p.address.zip,
  };
}

/** Build the `<TYPE>FormData` object for a record from its box values + registry map. */
function formDataFor(rec: IrisFormRecord, formType: TaxBanditsFormType): Record<string, unknown> {
  const map = BOX_FIELD_MAP[formType];
  const data: Record<string, unknown> = {};
  const states: TbStateInfo[] = [];
  let state: TbStateInfo | null = null;

  for (const [boxId, v] of Object.entries(rec.boxValues)) {
    if (v == null) continue;
    // state withholding block → States[]
    if (boxId === 'stateCode' && typeof v === 'string' && v !== '') {
      state = { ...(state ?? { StateCd: '' }), StateCd: v };
      continue;
    }
    if (boxId === 'stateTaxWithheld' && typeof v === 'number' && (v > 0 || rec.corrected)) {
      state = { ...(state ?? { StateCd: '' }), StateWHAmt: centsToNumber(v) };
      continue;
    }
    if (boxId === 'stateIncome' && typeof v === 'number' && (v > 0 || rec.corrected)) {
      state = { ...(state ?? { StateCd: '' }), StateIncomeAmt: centsToNumber(v) };
      continue;
    }
    if (boxId === 'statePayerStateNo' && typeof v === 'string' && v !== '') {
      state = { ...(state ?? { StateCd: '' }), StateIdNum: v };
      continue;
    }
    const field = map[boxId];
    if (!field) continue; // unmapped box (e.g. a box this form doesn't file via TaxBandits)
    if (typeof v === 'number') {
      if (v > 0 || rec.corrected) data[field] = centsToNumber(v);
    } else if (typeof v === 'boolean') {
      if (v) data[field] = true;
    } else if (typeof v === 'string' && v !== '') {
      data[field] = v;
    }
  }

  if (state && state.StateCd) states.push(state);
  data['AccountNum'] = rec.accountNumber ?? '';
  if (rec.secondTinNotice) data['IsSecondTINnot'] = true;
  if (states.length) data['States'] = states;
  return data;
}

function returnDataItem(rec: IrisFormRecord, formType: TaxBanditsFormType): TbReturnDataItem {
  const item: TbReturnDataItem = {
    SequenceId: rec.recordId,
    RecordId: null,
    Recipient: {
      RecipientId: null,
      TINType: rec.recipient.tinType,
      TIN: rec.recipient.tin,
      FirstPayeeNm: rec.recipient.name1,
      SecondPayeeNm: rec.recipient.name2 || undefined,
      IsForeign: false,
      USAddress: usAddress(rec.recipient),
    },
  };
  const data = formDataFor(rec, formType);
  item[`${formType}FormData` as `${TaxBanditsFormType}FormData`] = data;
  return item;
}

/** The single form type of a set of records, or throw if mixed/empty/unsupported. */
export function taxbanditsFormTypeOf(records: { formType: FormType }[]): TaxBanditsFormType {
  const types = new Set(records.map((r) => r.formType));
  if (types.size === 0) throw new AppError(ErrorCodes.E_VALIDATION, 'No records to file', 400);
  if (types.size > 1) {
    throw new AppError(
      ErrorCodes.E_VALIDATION,
      `TaxBandits files one form type per submission — this batch mixes ${[...types].join(', ')}. File each form type as its own batch.`,
      400,
    );
  }
  const t = [...types][0]!;
  if (!isTaxBanditsFormType(t)) {
    throw new AppError(ErrorCodes.E_VALIDATION, `TaxBandits does not support 1099-${t} in this appliance`, 400);
  }
  return t;
}

export function buildTaxBanditsPayload(
  input: IrisTransmissionInput,
  delivery: TaxBanditsDeliveryOptions = {},
): TaxBanditsCreateRequest {
  const formType = taxbanditsFormTypeOf(input.records);
  const isState = input.cfsfStates.length > 0 || input.records.some((r) => hasStateData(r));
  return {
    formType,
    SubmissionManifest: {
      SubmissionId: null,
      TaxYear: String(input.taxYear),
      IsFederalFiling: true,
      IsStateFiling: isState,
      IsPostal: !!delivery.postalMailing,
      IsOnlineAccess: !!delivery.onlineAccess,
      IsScheduleFiling: false,
    },
    ReturnHeader: {
      Business: {
        BusinessNm: input.issuer.name1,
        TradeNm: input.issuer.name2 || undefined,
        IsEIN: input.issuer.tinType === 'EIN',
        EINorSSN: input.issuer.tin,
        Phone: input.issuer.phone || undefined,
        IsForeign: false,
        USAddress: usAddress(input.issuer),
      },
    },
    ReturnData: input.records.map((r) => returnDataItem(r, formType)),
  };
}

function hasStateData(rec: IrisFormRecord): boolean {
  const c = rec.boxValues['stateCode'];
  return typeof c === 'string' && c !== '';
}

/**
 * Provider-neutral pre-submit checks (no TCC required — TaxBandits holds it).
 * Runs against the built request so it also validates the homogeneous-form-type
 * invariant implicitly (a mixed batch already threw during the build).
 */
export function preSubmitCheckTaxBandits(payload: TaxBanditsCreateRequest): string[] {
  const problems: string[] = [];
  if (!payload.ReturnData.length) problems.push('No records in submission');
  if (!/^\d{9}$/.test(payload.ReturnHeader.Business.EINorSSN)) problems.push('Payer TIN is not 9 digits');
  for (const r of payload.ReturnData) {
    const ref = r.SequenceId;
    if (!/^\d{9}$/.test(r.Recipient.TIN)) problems.push(`Record ${ref}: recipient TIN is not 9 digits`);
    if (!r.Recipient.FirstPayeeNm) problems.push(`Record ${ref}: recipient name missing`);
    if (!r.Recipient.USAddress.ZipCd) problems.push(`Record ${ref}: recipient ZIP missing`);
  }
  return problems;
}
