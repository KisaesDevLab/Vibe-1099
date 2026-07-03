/**
 * Form-type registry — keyed by (form_type, tax_year).
 * Single source of truth mapping every box to:
 *  - staff/client grid presentation (label, kind)
 *  - IRIS XML element (Pub 5718 XSD; schema version pinned per tax year)
 *  - MO Pub 1220 payment amount code (B-record amount field position)
 *  - Copy B substitute-form template slot (Pub 1179)
 *
 * Add form types or tax years by extending REGISTRY — never by branching logic.
 */

export const FORM_TYPES = ['NEC', 'MISC', 'INT', 'DIV'] as const;
export type FormType = (typeof FORM_TYPES)[number];

export type BoxKind = 'cents' | 'checkbox' | 'code' | 'string';

export interface BoxDef {
  /** stable box id used as the jsonb key in form_records.box_values */
  id: string;
  /** printed box number on the official form, e.g. "1", "2a" */
  boxNumber: string;
  label: string;
  kind: BoxKind;
  /** IRIS XSD element name (form detail level) */
  irisElement?: string;
  /** Pub 1220 payment amount code (drives B-record payment amount fields) */
  moAmountCode?: string;
  /** template slot name in the Copy B Jinja2 template */
  copyBSlot?: string;
  /** part of the state boxes block */
  stateField?: boolean;
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  boxId?: string;
  code: string;
  message: string;
}

export interface FormRecordValues {
  /** box id -> cents (number) | boolean | string */
  [boxId: string]: number | boolean | string | null | undefined;
}

export interface FormValidationContext {
  backupWithholding: boolean; // recipient-level flag
  secondTinNotice: boolean;
  /** admin-configured override of the registry's federal threshold (cents; Settings → federal_thresholds) */
  federalThresholdCents?: number;
}

export interface FormDef {
  formType: FormType;
  taxYear: number;
  title: string;
  /** IRIS submission form type name */
  irisFormType: string;
  /** Pub 1220 A-record "Type of Return" code (2 chars, left-justified) */
  mo1220ReturnType: string;
  /** Pub 1220 A-record "Amount Codes" string is derived from boxes' moAmountCode */
  boxes: BoxDef[];
  /** federal filing threshold in cents (warn-only; from registry, per LOCKED decision) */
  federalThresholdCents?: number;
  federalThresholdNote?: string;
  validate: (values: FormRecordValues, ctx: FormValidationContext) => ValidationIssue[];
}

// ---------------------------------------------------------------------------
// shared state-box block (every form gets a 2-state block on paper; v1 models one state row)
// ---------------------------------------------------------------------------

function stateBoxes(startBox: number): BoxDef[] {
  return [
    {
      id: 'stateTaxWithheld',
      boxNumber: String(startBox),
      label: 'State tax withheld',
      kind: 'cents',
      irisElement: 'StateTaxWithheldAmt',
      copyBSlot: 'state_tax_withheld',
      stateField: true,
    },
    {
      id: 'statePayerStateNo',
      boxNumber: String(startBox + 1),
      label: 'State/Payer’s state no.',
      kind: 'string',
      irisElement: 'PayerStateIdNum',
      copyBSlot: 'state_payer_no',
      stateField: true,
    },
    {
      id: 'stateIncome',
      boxNumber: String(startBox + 2),
      label: 'State income',
      kind: 'cents',
      irisElement: 'StateDistributionAmt',
      copyBSlot: 'state_income',
      stateField: true,
    },
    {
      id: 'stateCode',
      boxNumber: '',
      label: 'State',
      kind: 'code',
      irisElement: 'StateAbbreviationCd',
      copyBSlot: 'state_code',
      stateField: true,
    },
  ];
}

function cents(values: FormRecordValues, id: string): number {
  const v = values[id];
  return typeof v === 'number' ? v : 0;
}

function commonValidate(def: FormDef, values: FormRecordValues, ctx: FormValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // negative amounts never allowed on these forms
  for (const box of def.boxes) {
    if (box.kind === 'cents') {
      const v = values[box.id];
      if (v != null && typeof v !== 'number') {
        issues.push({ severity: 'error', boxId: box.id, code: 'E_BOX_TYPE', message: `${box.label} must be an amount` });
      } else if (typeof v === 'number' && v < 0) {
        issues.push({ severity: 'error', boxId: box.id, code: 'E_NEGATIVE', message: `${box.label} cannot be negative` });
      } else if (typeof v === 'number' && !Number.isInteger(v)) {
        issues.push({ severity: 'error', boxId: box.id, code: 'E_NOT_CENTS', message: `${box.label} must be integer cents` });
      }
    }
  }

  // at least one money amount or checkbox must be present
  const anyValue = def.boxes.some((b) => {
    const v = values[b.id];
    if (b.kind === 'cents') return typeof v === 'number' && v > 0;
    if (b.kind === 'checkbox') return v === true;
    return false;
  });
  if (!anyValue) {
    issues.push({ severity: 'error', code: 'E_EMPTY_FORM', message: 'Form has no reportable amounts' });
  }

  // federal withholding requires backup-withholding context
  const fedWithheld = cents(values, 'fedTaxWithheld');
  if (fedWithheld > 0 && !ctx.backupWithholding) {
    issues.push({
      severity: 'warning',
      boxId: 'fedTaxWithheld',
      code: 'W_BACKUP_WH',
      message: 'Federal tax withheld entered but recipient is not flagged for backup withholding — verify',
    });
  }

  // state box interdependency: withholding without payer state number
  const stw = cents(values, 'stateTaxWithheld');
  if (stw > 0 && !values['statePayerStateNo']) {
    issues.push({
      severity: 'error',
      boxId: 'statePayerStateNo',
      code: 'E_STATE_ID_REQUIRED',
      message: 'State tax withheld requires the payer state ID number',
    });
  }
  if (stw > 0 && !values['stateCode']) {
    issues.push({
      severity: 'error',
      boxId: 'stateCode',
      code: 'E_STATE_CODE_REQUIRED',
      message: 'State tax withheld requires a state code',
    });
  }

  // registry-driven federal threshold — warn, never block (LOCKED decision).
  // Admin settings may override the registry default per (form type, tax year).
  const thresholdCents = ctx.federalThresholdCents ?? def.federalThresholdCents;
  if (thresholdCents != null) {
    const primary = def.formType === 'NEC' ? cents(values, 'box1') : undefined;
    if (primary != null && primary > 0 && primary < thresholdCents) {
      issues.push({
        severity: 'warning',
        boxId: 'box1',
        code: 'W_UNDER_THRESHOLD',
        message:
          ctx.federalThresholdCents != null
            ? `Amount is under the configured federal filing threshold ($${(thresholdCents / 100).toLocaleString('en-US')}) for TY${def.taxYear} — filing is optional but permitted`
            : (def.federalThresholdNote ??
              `Amount is under the federal filing threshold for TY${def.taxYear} — filing is optional but permitted`),
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// TY2026 definitions (TY2025 seeded from same layouts for prior-year/corrections)
// ---------------------------------------------------------------------------

function necDef(taxYear: number): FormDef {
  const def: FormDef = {
    formType: 'NEC',
    taxYear,
    title: 'Nonemployee Compensation',
    irisFormType: 'Form1099NEC',
    mo1220ReturnType: 'NE',
    federalThresholdCents: taxYear >= 2026 ? 200000 : 60000,
    federalThresholdNote:
      taxYear >= 2026
        ? 'Under the TY2026 OBBBA federal threshold ($2,000) — filing is optional but permitted; state rules may still require it'
        : 'Under the $600 federal threshold — filing is optional but permitted',
    boxes: [
      { id: 'box1', boxNumber: '1', label: 'Nonemployee compensation', kind: 'cents', irisElement: 'NonemployeeCompensationAmt', moAmountCode: '1', copyBSlot: 'box1' },
      { id: 'directSales', boxNumber: '2', label: 'Direct sales of $5,000 or more', kind: 'checkbox', irisElement: 'DirectSalesInd', copyBSlot: 'box2' },
      { id: 'fedTaxWithheld', boxNumber: '4', label: 'Federal income tax withheld', kind: 'cents', irisElement: 'FederalIncomeTaxWithheldAmt', moAmountCode: '4', copyBSlot: 'box4' },
      ...stateBoxes(5),
    ],
    validate: (values, ctx) => commonValidate(def, values, ctx),
  };
  return def;
}

function miscDef(taxYear: number): FormDef {
  const def: FormDef = {
    formType: 'MISC',
    taxYear,
    title: 'Miscellaneous Information',
    irisFormType: 'Form1099MISC',
    mo1220ReturnType: 'A ',
    boxes: [
      { id: 'box1', boxNumber: '1', label: 'Rents', kind: 'cents', irisElement: 'RentsAmt', moAmountCode: '1', copyBSlot: 'box1' },
      { id: 'box2', boxNumber: '2', label: 'Royalties', kind: 'cents', irisElement: 'RoyaltiesAmt', moAmountCode: '2', copyBSlot: 'box2' },
      { id: 'box3', boxNumber: '3', label: 'Other income', kind: 'cents', irisElement: 'OtherIncomeAmt', moAmountCode: '3', copyBSlot: 'box3' },
      { id: 'fedTaxWithheld', boxNumber: '4', label: 'Federal income tax withheld', kind: 'cents', irisElement: 'FederalIncomeTaxWithheldAmt', moAmountCode: '4', copyBSlot: 'box4' },
      { id: 'box5', boxNumber: '5', label: 'Fishing boat proceeds', kind: 'cents', irisElement: 'FishingBoatProceedsAmt', moAmountCode: '5', copyBSlot: 'box5' },
      { id: 'box6', boxNumber: '6', label: 'Medical and health care payments', kind: 'cents', irisElement: 'MedicalHealthCarePaymentsAmt', moAmountCode: '6', copyBSlot: 'box6' },
      { id: 'directSales', boxNumber: '7', label: 'Direct sales of $5,000 or more', kind: 'checkbox', irisElement: 'DirectSalesInd', copyBSlot: 'box7' },
      { id: 'box8', boxNumber: '8', label: 'Substitute payments in lieu of dividends or interest', kind: 'cents', irisElement: 'SubstitutePaymentsAmt', moAmountCode: '8', copyBSlot: 'box8' },
      { id: 'box9', boxNumber: '9', label: 'Crop insurance proceeds', kind: 'cents', irisElement: 'CropInsuranceProceedsAmt', moAmountCode: '9', copyBSlot: 'box9' },
      { id: 'box10', boxNumber: '10', label: 'Gross proceeds paid to an attorney', kind: 'cents', irisElement: 'GrossProceedsPaidToAttorneyAmt', moAmountCode: 'C', copyBSlot: 'box10' },
      { id: 'box11', boxNumber: '11', label: 'Fish purchased for resale', kind: 'cents', irisElement: 'FishPurchasedForResaleAmt', moAmountCode: 'D', copyBSlot: 'box11' },
      { id: 'box12', boxNumber: '12', label: 'Section 409A deferrals', kind: 'cents', irisElement: 'Section409ADeferralsAmt', moAmountCode: 'E', copyBSlot: 'box12' },
      { id: 'fatca', boxNumber: '13', label: 'FATCA filing requirement', kind: 'checkbox', irisElement: 'FATCAFilingRequirementInd', copyBSlot: 'box13' },
      { id: 'box14', boxNumber: '14', label: 'Excess golden parachute payments', kind: 'cents', irisElement: 'ExcessGoldenParachutePaymentAmt', moAmountCode: 'B', copyBSlot: 'box14' },
      { id: 'box15', boxNumber: '15', label: 'Nonqualified deferred compensation', kind: 'cents', irisElement: 'NonqualifiedDeferredCompensationAmt', moAmountCode: 'F', copyBSlot: 'box15' },
      ...stateBoxes(16),
    ],
    validate: (values, ctx) => commonValidate(def, values, ctx),
  };
  return def;
}

function intDef(taxYear: number): FormDef {
  const def: FormDef = {
    formType: 'INT',
    taxYear,
    title: 'Interest Income',
    irisFormType: 'Form1099INT',
    mo1220ReturnType: '6 ',
    boxes: [
      { id: 'box1', boxNumber: '1', label: 'Interest income', kind: 'cents', irisElement: 'InterestIncomeAmt', moAmountCode: '1', copyBSlot: 'box1' },
      { id: 'box2', boxNumber: '2', label: 'Early withdrawal penalty', kind: 'cents', irisElement: 'EarlyWithdrawalPenaltyAmt', moAmountCode: '2', copyBSlot: 'box2' },
      { id: 'box3', boxNumber: '3', label: 'Interest on U.S. Savings Bonds and Treasury obligations', kind: 'cents', irisElement: 'USSavingsBondsInterestAmt', moAmountCode: '3', copyBSlot: 'box3' },
      { id: 'fedTaxWithheld', boxNumber: '4', label: 'Federal income tax withheld', kind: 'cents', irisElement: 'FederalIncomeTaxWithheldAmt', moAmountCode: '4', copyBSlot: 'box4' },
      { id: 'box5', boxNumber: '5', label: 'Investment expenses', kind: 'cents', irisElement: 'InvestmentExpensesAmt', moAmountCode: '5', copyBSlot: 'box5' },
      { id: 'box6', boxNumber: '6', label: 'Foreign tax paid', kind: 'cents', irisElement: 'ForeignTaxPaidAmt', moAmountCode: '6', copyBSlot: 'box6' },
      { id: 'box7', boxNumber: '7', label: 'Foreign country or U.S. possession', kind: 'string', irisElement: 'ForeignCountryNm', copyBSlot: 'box7' },
      { id: 'box8', boxNumber: '8', label: 'Tax-exempt interest', kind: 'cents', irisElement: 'TaxExemptInterestAmt', moAmountCode: '8', copyBSlot: 'box8' },
      { id: 'box9', boxNumber: '9', label: 'Specified private activity bond interest', kind: 'cents', irisElement: 'SpecifiedPrivateActivityBondInterestAmt', moAmountCode: '9', copyBSlot: 'box9' },
      { id: 'box10', boxNumber: '10', label: 'Market discount', kind: 'cents', irisElement: 'MarketDiscountAmt', moAmountCode: 'A', copyBSlot: 'box10' },
      { id: 'box11', boxNumber: '11', label: 'Bond premium', kind: 'cents', irisElement: 'BondPremiumAmt', moAmountCode: 'B', copyBSlot: 'box11' },
      { id: 'box12', boxNumber: '12', label: 'Bond premium on Treasury obligations', kind: 'cents', irisElement: 'TreasuryBondPremiumAmt', moAmountCode: 'E', copyBSlot: 'box12' },
      { id: 'box13', boxNumber: '13', label: 'Bond premium on tax-exempt bond', kind: 'cents', irisElement: 'TaxExemptBondPremiumAmt', moAmountCode: 'D', copyBSlot: 'box13' },
      { id: 'fatca', boxNumber: '', label: 'FATCA filing requirement', kind: 'checkbox', irisElement: 'FATCAFilingRequirementInd', copyBSlot: 'fatca' },
      { id: 'box14', boxNumber: '14', label: 'Tax-exempt and tax credit bond CUSIP no.', kind: 'string', irisElement: 'CUSIPNum', copyBSlot: 'box14' },
      ...stateBoxes(15),
    ],
    validate: (values, ctx) => commonValidate(def, values, ctx),
  };
  return def;
}

function divDef(taxYear: number): FormDef {
  const def: FormDef = {
    formType: 'DIV',
    taxYear,
    title: 'Dividends and Distributions',
    irisFormType: 'Form1099DIV',
    mo1220ReturnType: '1 ',
    boxes: [
      { id: 'box1a', boxNumber: '1a', label: 'Total ordinary dividends', kind: 'cents', irisElement: 'TotalOrdinaryDividendsAmt', moAmountCode: '1', copyBSlot: 'box1a' },
      { id: 'box1b', boxNumber: '1b', label: 'Qualified dividends', kind: 'cents', irisElement: 'QualifiedDividendsAmt', moAmountCode: '2', copyBSlot: 'box1b' },
      { id: 'box2a', boxNumber: '2a', label: 'Total capital gain distr.', kind: 'cents', irisElement: 'TotalCapitalGainDistributionsAmt', moAmountCode: '3', copyBSlot: 'box2a' },
      { id: 'box2b', boxNumber: '2b', label: 'Unrecap. Sec. 1250 gain', kind: 'cents', irisElement: 'UnrecapturedSection1250GainAmt', moAmountCode: '6', copyBSlot: 'box2b' },
      { id: 'box2c', boxNumber: '2c', label: 'Section 1202 gain', kind: 'cents', irisElement: 'Section1202GainAmt', moAmountCode: '7', copyBSlot: 'box2c' },
      { id: 'box2d', boxNumber: '2d', label: 'Collectibles (28%) gain', kind: 'cents', irisElement: 'CollectiblesGainAmt', moAmountCode: '8', copyBSlot: 'box2d' },
      { id: 'box2e', boxNumber: '2e', label: 'Section 897 ordinary dividends', kind: 'cents', irisElement: 'Section897OrdinaryDividendsAmt', moAmountCode: 'H', copyBSlot: 'box2e' },
      { id: 'box2f', boxNumber: '2f', label: 'Section 897 capital gain', kind: 'cents', irisElement: 'Section897CapitalGainAmt', moAmountCode: 'J', copyBSlot: 'box2f' },
      { id: 'box3', boxNumber: '3', label: 'Nondividend distributions', kind: 'cents', irisElement: 'NondividendDistributionsAmt', moAmountCode: '9', copyBSlot: 'box3' },
      { id: 'fedTaxWithheld', boxNumber: '4', label: 'Federal income tax withheld', kind: 'cents', irisElement: 'FederalIncomeTaxWithheldAmt', moAmountCode: 'A', copyBSlot: 'box4' },
      { id: 'box5', boxNumber: '5', label: 'Section 199A dividends', kind: 'cents', irisElement: 'Section199ADividendsAmt', moAmountCode: '5', copyBSlot: 'box5' },
      { id: 'box6', boxNumber: '6', label: 'Investment expenses', kind: 'cents', irisElement: 'InvestmentExpensesAmt', moAmountCode: 'B', copyBSlot: 'box6' },
      { id: 'box7', boxNumber: '7', label: 'Foreign tax paid', kind: 'cents', irisElement: 'ForeignTaxPaidAmt', moAmountCode: 'C', copyBSlot: 'box7' },
      { id: 'box8', boxNumber: '8', label: 'Foreign country or U.S. possession', kind: 'string', irisElement: 'ForeignCountryNm', copyBSlot: 'box8' },
      { id: 'box9', boxNumber: '9', label: 'Cash liquidation distributions', kind: 'cents', irisElement: 'CashLiquidationDistributionsAmt', moAmountCode: 'D', copyBSlot: 'box9' },
      { id: 'box10', boxNumber: '10', label: 'Noncash liquidation distributions', kind: 'cents', irisElement: 'NoncashLiquidationDistributionsAmt', moAmountCode: 'E', copyBSlot: 'box10' },
      { id: 'fatca', boxNumber: '11', label: 'FATCA filing requirement', kind: 'checkbox', irisElement: 'FATCAFilingRequirementInd', copyBSlot: 'box11' },
      { id: 'box12', boxNumber: '12', label: 'Exempt-interest dividends', kind: 'cents', irisElement: 'ExemptInterestDividendsAmt', moAmountCode: 'F', copyBSlot: 'box12' },
      { id: 'box13', boxNumber: '13', label: 'Specified private activity bond interest dividends', kind: 'cents', irisElement: 'SpecifiedPrivateActivityBondInterestDividendsAmt', moAmountCode: 'G', copyBSlot: 'box13' },
      ...stateBoxes(14),
    ],
    validate: (values, ctx) => {
      const issues = commonValidate(def, values, ctx);
      const ord = cents(values, 'box1a');
      const qual = cents(values, 'box1b');
      if (qual > ord) {
        issues.push({
          severity: 'error',
          boxId: 'box1b',
          code: 'E_QUAL_GT_ORD',
          message: 'Qualified dividends (1b) cannot exceed total ordinary dividends (1a)',
        });
      }
      return issues;
    },
  };
  return def;
}

// ---------------------------------------------------------------------------

/** Baseline years shipped with the build; admins can roll forward to new years. */
export const SUPPORTED_TAX_YEARS = [2025, 2026] as const;
/** Earliest year the parameterized layouts are valid for (guards typo'd years). */
export const MIN_TAX_YEAR = 2025;
/** Furthest ahead an admin may roll the filing year (sanity bound). */
export const MAX_TAX_YEAR = 2035;

const REGISTRY = new Map<string, FormDef>();

function buildDef(formType: FormType, taxYear: number): FormDef {
  switch (formType) {
    case 'NEC':
      return necDef(taxYear);
    case 'MISC':
      return miscDef(taxYear);
    case 'INT':
      return intDef(taxYear);
    case 'DIV':
      return divDef(taxYear);
  }
}

for (const ty of SUPPORTED_TAX_YEARS) {
  for (const ft of FORM_TYPES) {
    REGISTRY.set(`${ft}:${ty}`, buildDef(ft, ty));
  }
}

export function getFormDef(formType: FormType, taxYear: number): FormDef {
  const key = `${formType}:${taxYear}`;
  let def = REGISTRY.get(key);
  if (!def) {
    // Layouts are parameterized by year, so any in-range year rolls forward from
    // the same definitions (thresholds branch on year internally). Build + cache.
    if (taxYear < MIN_TAX_YEAR || taxYear > MAX_TAX_YEAR) {
      throw new Error(`Unsupported form/year: ${formType} TY${taxYear}`);
    }
    def = buildDef(formType, taxYear);
    REGISTRY.set(key, def);
  }
  return def;
}

export function listFormDefs(taxYear: number): FormDef[] {
  return FORM_TYPES.map((ft) => getFormDef(ft, taxYear));
}

export function isSupportedYear(taxYear: number): boolean {
  return taxYear >= MIN_TAX_YEAR && taxYear <= MAX_TAX_YEAR;
}

/** Pub 1220 A-record Amount Codes string: sorted 0-9 then A-Z, from box moAmountCode values. */
export function moAmountCodes(def: FormDef): string {
  const codes = def.boxes.filter((b) => b.moAmountCode).map((b) => b.moAmountCode as string);
  return codes.sort((a, b) => {
    const aNum = /^\d$/.test(a);
    const bNum = /^\d$/.test(b);
    if (aNum && !bNum) return -1;
    if (!aNum && bNum) return 1;
    return a.localeCompare(b);
  }).join('');
}

/** Filing-season deadlines for a tax year (filed in taxYear+1). */
export function deadlinesFor(taxYear: number): { recipientFurnish: string; irsEfile: string; missouri: string } {
  const y = taxYear + 1;
  const feb = new Date(Date.UTC(y, 1, 29)).getUTCDate() === 29 ? `${y}-02-29` : `${y}-02-28`;
  return {
    recipientFurnish: `${y}-01-31`, // Jan 31 (NEC to IRS also Jan 31)
    irsEfile: `${y}-03-31`, // MISC/INT/DIV e-file; NEC is Jan 31 — surfaced in dashboard copy
    missouri: feb, // last day of February
  };
}
