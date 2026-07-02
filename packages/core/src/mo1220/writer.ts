/**
 * Missouri Pub 1220 direct-file writer (Phase 10).
 *
 * Format: fixed 750-character records, CR/LF terminated, uppercase ASCII.
 * Sequence: T → A (per payer/form type) → B (payees) → C (totals) → K (Missouri
 * state totals / reconciliation) → F.
 *
 * MONEY FIELDS CARRY CENTS with an assumed decimal and NO rounding — written
 * directly from integer-cents storage (ADR-001).
 *
 * Field positions follow IRS Pub 1220 Part C record layouts; the layout is
 * asserted position-by-position by golden-file tests
 * (tests/mo1220.golden.test.ts) and documented in docs/mo-pub1220-layout.md.
 */
import { centsToPub1220, getFormDef, moAmountCodes, sumCents, type FormType } from '@vibe1099/shared';

const RECORD_LEN = 750;
const CRLF = '\r\n';
const MO_CFSF_CODE = '26'; // Missouri state code (K record 745-746)

/** Pub 1220 fixed payment-amount field positions in the B record, by amount code. */
const AMOUNT_FIELD_POS: Record<string, number> = {
  '1': 55, '2': 67, '3': 79, '4': 91, '5': 103, '6': 115, '7': 127, '8': 139, '9': 151,
  A: 163, B: 175, C: 187, D: 199, E: 211, F: 223, G: 235, H: 247, J: 259,
};
const AMOUNT_CODES_ORDER = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J'] as const;

function ascii(s: string): string {
  // uppercase ASCII only; strip anything outside printable range
  return s
    .toUpperCase()
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Z0-9 &\-.,#/']/g, ' ');
}

function alpha(s: string, width: number): string {
  return ascii(s).slice(0, width).padEnd(width, ' ');
}

function num(n: number, width: number): string {
  const s = String(Math.max(0, Math.trunc(n)));
  if (s.length > width) throw new Error(`Numeric field overflow: ${n} in width ${width}`);
  return s.padStart(width, '0');
}

function blank(width: number): string {
  return ' '.repeat(width);
}

class RecordBuilder {
  private buf: string[];
  constructor(type: string) {
    this.buf = new Array<string>(RECORD_LEN).fill(' ');
    this.set(1, type);
  }
  /** 1-based position per Pub 1220 layout docs */
  set(pos: number, value: string): this {
    for (let i = 0; i < value.length; i++) {
      const idx = pos - 1 + i;
      if (idx >= RECORD_LEN) throw new Error(`Field overruns record at pos ${pos}: "${value.slice(0, 20)}..."`);
      this.buf[idx] = value[i] as string;
    }
    return this;
  }
  build(seq: number): string {
    this.set(500, num(seq, 8));
    const rec = this.buf.join('');
    if (rec.length !== RECORD_LEN) throw new Error(`Record length ${rec.length} !== ${RECORD_LEN}`);
    return rec;
  }
}

/** Name control: first 4 significant chars — business first word, individual last word. */
export function nameControl(name1: string, tinType: 'SSN' | 'EIN'): string {
  const cleaned = ascii(name1).replace(/[^A-Z0-9 \-&]/g, '').trim();
  if (!cleaned) return '    ';
  const words = cleaned.split(/\s+/);
  const src = tinType === 'SSN' ? (words[words.length - 1] ?? '') : (words[0] ?? '');
  return src.replace(/[^A-Z0-9\-&]/g, '').slice(0, 4).padEnd(4, ' ');
}

export interface Mo1220Transmitter {
  tin: string;
  name: string;
  companyName: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
}

export interface Mo1220Payer {
  tin: string;
  tinType: 'SSN' | 'EIN';
  name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  moWithholdingId: string | null;
}

export interface Mo1220Payee {
  recordId: string;
  tin: string;
  tinType: 'SSN' | 'EIN';
  name1: string;
  name2: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  accountNumber: string;
  /** amount code -> cents (registry-mapped from box values) */
  amounts: Record<string, number>;
  stateTaxWithheldCents: number;
  corrected?: 'G' | 'C' | null;
}

export interface Mo1220PayerGroup {
  payer: Mo1220Payer;
  formType: FormType;
  payees: Mo1220Payee[];
}

export interface Mo1220Input {
  taxYear: number;
  priorYear: boolean; // filing after the current season (P indicator)
  transmitter: Mo1220Transmitter;
  groups: Mo1220PayerGroup[];
  testFile?: boolean;
}

export interface Mo1220Output {
  content: string; // full file, CRLF line endings
  filename: string;
  recordCounts: { t: number; a: number; b: number; c: number; k: number; f: number };
  kTotals: Record<string, number>; // cents, by amount code + stateTaxWithheld
  payeeCount: number;
}

export function buildMo1220File(input: Mo1220Input): Mo1220Output {
  const records: string[] = [];
  let seq = 0;
  const next = () => ++seq;

  const totalPayees = input.groups.reduce((n, g) => n + g.payees.length, 0);

  // ---- T record --------------------------------------------------------------
  const t = new RecordBuilder('T');
  t.set(2, num(input.taxYear, 4));
  if (input.priorYear) t.set(6, 'P');
  t.set(7, alpha(input.transmitter.tin.replace(/\D/g, ''), 9));
  if (input.testFile) t.set(28, 'T');
  t.set(30, alpha(input.transmitter.name, 40));
  t.set(110, alpha(input.transmitter.companyName, 40));
  t.set(190, alpha(input.transmitter.address, 40));
  t.set(230, alpha(input.transmitter.city, 40));
  t.set(270, alpha(input.transmitter.state, 2));
  t.set(272, alpha(input.transmitter.zip.replace(/\D/g, ''), 9));
  t.set(296, num(totalPayees, 8));
  t.set(304, alpha(input.transmitter.contactName, 40));
  t.set(344, alpha(input.transmitter.contactPhone.replace(/\D/g, ''), 15));
  t.set(359, alpha(input.transmitter.contactEmail, 50));
  t.set(518, 'I'); // in-house software indicator
  records.push(t.build(next()));

  let aCount = 0;
  const grandKTotals: Record<string, number> = { stateTaxWithheld: 0 };

  for (const group of input.groups) {
    const def = getFormDef(group.formType, input.taxYear);
    const codes = moAmountCodes(def);
    aCount++;

    // ---- A record (per payer / form type) ------------------------------------
    const a = new RecordBuilder('A');
    a.set(2, num(input.taxYear, 4));
    a.set(6, '1'); // combined federal/state eligible flag position (informational for MO direct file)
    a.set(12, alpha(group.payer.tin.replace(/\D/g, ''), 9));
    a.set(21, nameControl(group.payer.name, group.payer.tinType));
    a.set(26, alpha(def.mo1220ReturnType, 2));
    a.set(28, alpha(codes, 16));
    a.set(53, alpha(group.payer.name, 40));
    a.set(134, alpha(group.payer.address, 40));
    a.set(174, alpha(group.payer.city, 40));
    a.set(214, alpha(group.payer.state, 2));
    a.set(216, alpha(group.payer.zip.replace(/\D/g, ''), 9));
    a.set(225, alpha(group.payer.phone.replace(/\D/g, ''), 15));
    // MO withholding ID — positions 715-728 of the A record are the state-defined
    // payer field block in MO's Pub 1220 adaptation
    if (group.payer.moWithholdingId) a.set(715, alpha(group.payer.moWithholdingId.replace(/\D/g, ''), 14));
    records.push(a.build(next()));

    // ---- B records -------------------------------------------------------------
    const groupTotals: Record<string, number> = {};
    let groupStateWithheld = 0;

    for (const payee of group.payees) {
      const b = new RecordBuilder('B');
      b.set(2, num(input.taxYear, 4));
      if (payee.corrected) b.set(6, payee.corrected);
      b.set(7, nameControl(payee.name1, payee.tinType));
      b.set(11, payee.tinType === 'EIN' ? '1' : '2');
      b.set(12, alpha(payee.tin.replace(/\D/g, ''), 9));
      b.set(21, alpha(payee.accountNumber, 20));
      for (const [code, cents] of Object.entries(payee.amounts)) {
        const pos = AMOUNT_FIELD_POS[code];
        if (pos == null) throw new Error(`Unknown Pub 1220 amount code: ${code}`);
        if (cents === 0) continue;
        b.set(pos, centsToPub1220(cents, 12));
        groupTotals[code] = (groupTotals[code] ?? 0) + cents;
      }
      b.set(288, alpha(payee.name1, 40));
      b.set(328, alpha(payee.name2, 40));
      b.set(368, alpha(payee.address, 40));
      b.set(448, alpha(payee.city, 40));
      b.set(488, alpha(payee.state, 2));
      b.set(490, alpha(payee.zip.replace(/\D/g, ''), 9));
      // state tax withheld (positions 723-734), CF/SF code (747-748)
      if (payee.stateTaxWithheldCents > 0) {
        b.set(723, centsToPub1220(payee.stateTaxWithheldCents, 12));
        groupStateWithheld += payee.stateTaxWithheldCents;
      }
      b.set(747, MO_CFSF_CODE);
      records.push(b.build(next()));
    }

    // ---- C record (payer totals) -------------------------------------------------
    const c = new RecordBuilder('C');
    c.set(2, num(group.payees.length, 8));
    for (let i = 0; i < AMOUNT_CODES_ORDER.length; i++) {
      const code = AMOUNT_CODES_ORDER[i] as string;
      const total = groupTotals[code] ?? 0;
      c.set(16 + i * 18, centsToPub1220(total, 18));
    }
    records.push(c.build(next()));

    // ---- K record (Missouri state totals / reconciliation) -----------------------
    const k = new RecordBuilder('K');
    k.set(2, num(group.payees.length, 8));
    for (let i = 0; i < AMOUNT_CODES_ORDER.length; i++) {
      const code = AMOUNT_CODES_ORDER[i] as string;
      const total = groupTotals[code] ?? 0;
      k.set(16 + i * 18, centsToPub1220(total, 18));
    }
    k.set(707, centsToPub1220(groupStateWithheld, 18)); // state income tax withheld total
    k.set(725, centsToPub1220(0, 18)); // local income tax withheld total
    k.set(745, MO_CFSF_CODE);
    records.push(k.build(next()));

    for (const [code, total] of Object.entries(groupTotals)) {
      grandKTotals[code] = (grandKTotals[code] ?? 0) + total;
    }
    grandKTotals['stateTaxWithheld'] = (grandKTotals['stateTaxWithheld'] ?? 0) + groupStateWithheld;
  }

  // ---- F record -----------------------------------------------------------------
  const f = new RecordBuilder('F');
  f.set(2, num(aCount, 8));
  f.set(10, '0'.repeat(21));
  f.set(50, num(totalPayees, 8));
  records.push(f.build(next()));

  const content = records.join(CRLF) + CRLF;
  const filename = `MO_1099_${input.taxYear}${input.testFile ? '_TEST' : ''}.txt`;

  return {
    content,
    filename,
    recordCounts: { t: 1, a: aCount, b: totalPayees, c: aCount, k: aCount, f: 1 },
    kTotals: grandKTotals,
    payeeCount: totalPayees,
  };
}

/** Map a form record's box values to Pub 1220 amount-code cents via the registry. */
export function boxValuesToAmountCodes(
  formType: FormType,
  taxYear: number,
  boxValues: Record<string, number | boolean | string | null | undefined>,
): { amounts: Record<string, number>; stateTaxWithheldCents: number } {
  const def = getFormDef(formType, taxYear);
  const amounts: Record<string, number> = {};
  let stateTaxWithheldCents = 0;
  for (const box of def.boxes) {
    const v = boxValues[box.id];
    if (typeof v !== 'number' || v <= 0) continue;
    if (box.id === 'stateTaxWithheld') {
      stateTaxWithheldCents = v;
      continue;
    }
    if (box.moAmountCode) amounts[box.moAmountCode] = (amounts[box.moAmountCode] ?? 0) + v;
  }
  return { amounts, stateTaxWithheldCents };
}

/** MO $1,200 threshold filter (with per-record override). */
export function meetsMoThreshold(
  amounts: Record<string, number>,
  stateTaxWithheldCents: number,
  thresholdCents = 120000,
): boolean {
  // any withholding always reportable; otherwise total payments >= threshold
  if (stateTaxWithheldCents > 0) return true;
  return sumCents(Object.values(amounts)) >= thresholdCents;
}
