/**
 * Prior-year 1099 print-PDF parser (staff import: upload -> parse -> review -> import).
 *
 * Input is the per-page text layer of a "print" PDF — the flattened form copies a
 * filing package produces (Copy 1 / Copy B / Copy C sheets, often 2-up or 3-up).
 * Generators draw the IRS template text and the filled values into the same text
 * layer, so extraction sees boilerplate and data interleaved. Strategy:
 *
 *   1. drop known IRS-template lines (label blacklist),
 *   2. anchor form blocks on TIN-shaped lines — the TIN that repeats across
 *      blocks is the payer; every other TIN opens a recipient block,
 *   3. read name/address lines around the anchors, terminated by a
 *      "City, ST 12345" line.
 *
 * The output is a *proposal* reviewed and edited by staff before anything is
 * written — the parser favors recall over precision and reports every doubt in
 * `warnings`. Never log the returned object: it carries plaintext TINs.
 */

export interface ParsedAddress {
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
}

export interface ParsedParty {
  /** Plaintext TIN as printed ('' when the print masks it). */
  tin: string;
  tinType: 'SSN' | 'EIN' | null;
  /** True when the print shows a truncated TIN (XXX-XX-1234); tin is then ''. */
  tinMasked: boolean;
  tinLast4: string;
  name1: string;
  name2: string;
  address: ParsedAddress | null;
}

export interface ParsedRecipient extends ParsedParty {
  /** Box-1-ish amount printed near this form, for operator eyeballing only (dollars string, never imported). */
  amount: string | null;
}

export interface Print1099Parse {
  taxYear: number | null;
  formType: 'NEC' | 'MISC' | 'INT' | 'DIV' | null;
  payer: ParsedParty | null;
  recipients: ParsedRecipient[];
  warnings: string[];
}

// Lines containing any of these are IRS template text, not data. Curated from the
// 1099-NEC/MISC/INT/DIV Copy B/1/2 layouts; matching is case-insensitive substring.
const BOILERPLATE = [
  'payer’s', "payer's", 'payers', 'recipient’s', "recipient's", 'recipients',
  'form 1099', 'omb no', 'department of the treasury', 'internal revenue service',
  'www.irs.gov', 'calendar year', 'void', 'corrected', 'copy 1', 'copy 2', 'copy b', 'copy c',
  'for state tax', 'account number', 'street address', 'city or town', 'apt. no', 'see instructions',
  'nonemployee compensation', 'federal income tax withheld', 'state tax withheld', 'state income',
  'state/payer', 'payer made direct sales', 'consumer products', 'golden parachute', '(rev.',
  'rents', 'royalties', 'other income', 'fishing boat', 'medical and health', 'substitute payments',
  'crop insurance', 'gross proceeds', 'excess', 'section 409a', 'nonqualified deferred',
  'interest income', 'early withdrawal', 'u.s. savings bonds', 'investment expenses',
  'foreign tax', 'foreign country', 'specified private activity', 'market discount', 'bond premium',
  'ordinary dividends', 'qualified dividends', 'capital gain', 'nondividend', 'section 199a',
  'collectibles', 'unrecap', 'section 1202', 'exempt-interest', 'liquidation distributions',
  'fatca', '2nd tin not', 'this is important tax information', 'negligence penalty',
  'keep for your records', 'instructions for recipient',
];

// Orphan fragments of wrapped template lines ("Form 1099-NEC Nonemployee\nCompensation").
// Exact match only — substring matching would eat legitimate names.
const BOILERPLATE_EXACT = new Set([
  'compensation', 'department', 'miscellaneous', 'information', 'miscellaneous information',
  'income', 'dividends and', 'distributions', 'dividends and distributions', 'interest',
]);

const EIN_RE = /^(\d{2})-(\d{7})$/;
const SSN_RE = /^(\d{3})-(\d{2})-(\d{4})$/;
const BARE_TIN_RE = /^\d{9}$/;
// Truncated TINs on recipient copies (Pub 1179): XXX-XX-1234 / XX-XXX1234 / ***-**-1234
const MASKED_TIN_RE = /^[X*]{2,3}[-\s]?[X*]{2,3}[-\s]?\*{0,2}(\d{4})$/i;
const YEAR_RE = /^(20\d{2})$/;
const AMOUNT_RE = /^\$?(\d{1,3}(,\d{3})+|\d+)\.\d{2}$/;
const CITY_STATE_ZIP_RE = /^(.+?),\s*([A-Za-z]{2})[,\s]+(\d{5}(?:-\d{4})?)$/;
const COMPANY_NAME_RE = /\b(llc|l\.l\.c\.?|inc\.?|corp\.?|co\.?|company|corporation|ltd\.?|lp|llp|pllc|p\.c\.?|pc|services|associates|group|enterprises|construction|partners)\b/i;

type TinHit = { kind: 'full'; tin: string; tinType: 'SSN' | 'EIN' | null } | { kind: 'masked'; last4: string };

function classifyTin(line: string): TinHit | null {
  if (EIN_RE.test(line)) return { kind: 'full', tin: line, tinType: 'EIN' };
  if (SSN_RE.test(line)) return { kind: 'full', tin: line, tinType: 'SSN' };
  if (BARE_TIN_RE.test(line)) return { kind: 'full', tin: line, tinType: null }; // ambiguous, resolved by name shape
  const masked = MASKED_TIN_RE.exec(line);
  if (masked) return { kind: 'masked', last4: masked[1]! };
  return null;
}

function isBoilerplate(line: string): boolean {
  const l = line.toLowerCase();
  if (l === '$' || l === '') return true;
  if (BOILERPLATE_EXACT.has(l)) return true;
  return BOILERPLATE.some((b) => l.includes(b));
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Street-ish: starts with a number, or PO Box / rural-route shapes. */
function looksLikeStreet(line: string): boolean {
  return /^\d/.test(line) || /^p\.?\s?o\.?\s?box/i.test(line) || /^(rr|hc)\s?\d/i.test(line);
}

interface Block {
  nameAddr: string[]; // lines from name through city/state/zip
  tin: TinHit;
  amount: string | null;
}

/**
 * Read a party's name/address out of its block lines: first line(s) are names,
 * then street lines, closed by a "City, ST 12345" line.
 */
function readParty(lines: string[], tin: TinHit, warnings: string[], label: string): ParsedParty {
  const party: ParsedParty = {
    tin: tin.kind === 'full' ? tin.tin : '',
    tinType: tin.kind === 'full' ? tin.tinType : null,
    tinMasked: tin.kind === 'masked',
    tinLast4: tin.kind === 'masked' ? tin.last4 : tin.tin.replace(/\D/g, '').slice(-4),
    name1: '',
    name2: '',
    address: null,
  };

  const cityIdx = lines.findIndex((l) => CITY_STATE_ZIP_RE.test(l));
  const body = cityIdx >= 0 ? lines.slice(0, cityIdx) : [...lines];

  if (body.length > 0) party.name1 = collapse(body[0]!);
  const rest = body.slice(1);
  const firstStreet = rest.findIndex(looksLikeStreet);
  if (firstStreet > 0) party.name2 = collapse(rest.slice(0, firstStreet).join(' '));
  const streets = firstStreet >= 0 ? rest.slice(firstStreet) : [];

  if (cityIdx >= 0 && streets.length > 0) {
    const m = CITY_STATE_ZIP_RE.exec(lines[cityIdx]!)!;
    party.address = {
      line1: collapse(streets[0]!),
      line2: collapse(streets.slice(1).join(' ')),
      city: collapse(m[1]!),
      state: m[2]!.toUpperCase(),
      zip: m[3]!,
    };
    // "5325 N Oak St, Apt D-303" prints as one line — split the unit into line2
    if (!party.address.line2) {
      const unit = /^(.*?),\s+((?:apt|suite|ste|unit|#|bldg|rm|fl)\.?\s*\S.*)$/i.exec(party.address.line1);
      if (unit) {
        party.address.line1 = unit[1]!.trim();
        party.address.line2 = unit[2]!.trim();
      }
    }
  } else {
    warnings.push(`${label}: could not read a full address (name "${party.name1 || '?'}") — fill it in during review.`);
  }

  // Bare 9-digit TIN: decide SSN vs EIN from the name shape, and say so.
  if (party.tin && party.tinType === null) {
    party.tinType = COMPANY_NAME_RE.test(party.name1) ? 'EIN' : 'SSN';
    warnings.push(`${label}: TIN printed without separators — assumed ${party.tinType} from the name; verify during review.`);
  }
  return party;
}

export function parse1099Print(pages: string[]): Print1099Parse {
  const warnings: string[] = [];
  const raw = pages.join('\n');

  // Form type / tax year come from the whole text (boilerplate included).
  const typeCounts = new Map<string, number>();
  for (const m of raw.matchAll(/1099-(NEC|MISC|INT|DIV)/g)) typeCounts.set(m[1]!, (typeCounts.get(m[1]!) ?? 0) + 1);
  const formType = ([...typeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null) as Print1099Parse['formType'];
  if (typeCounts.size > 1) warnings.push(`Multiple form types found (${[...typeCounts.keys()].join(', ')}) — parsed as 1099-${formType}.`);

  // Cap line length before regex matching: CITY_STATE_ZIP_RE's lazy `(.+?),`
  // scan is quadratic in line length, so an adversarial PDF with a megabyte
  // single line could stall the event loop. No legitimate print line is
  // anywhere near 400 chars.
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.slice(0, 400).trim())
    .filter((l) => l && !isBoilerplate(l));

  const years = lines.map((l) => YEAR_RE.exec(l)?.[1]).filter(Boolean) as string[];
  const taxYear = years.length ? Number(mode(years)) : null;

  // TIN occurrences in document order.
  const hits: Array<{ idx: number; hit: TinHit }> = [];
  lines.forEach((l, idx) => {
    const hit = classifyTin(l);
    if (hit) hits.push({ idx, hit });
  });
  if (hits.length === 0) {
    warnings.push(
      pages.every((p) => !p.trim())
        ? 'No text layer found — this looks like a scanned/image PDF, which needs OCR (not supported). Re-print the forms to PDF or enter the data manually.'
        : 'No TINs found in the PDF text — this does not look like a 1099 print file.',
    );
    return { taxYear, formType, payer: null, recipients: [], warnings };
  }

  // Payer = the full TIN that repeats most (it appears once per form). Fall back
  // to document order (payer box precedes recipient box) for single-form files.
  const fullCounts = new Map<string, number>();
  for (const { hit } of hits) if (hit.kind === 'full') fullCounts.set(hit.tin, (fullCounts.get(hit.tin) ?? 0) + 1);
  const byCount = [...fullCounts.entries()].sort((a, b) => b[1] - a[1]);
  const payerTin = byCount[0]?.[0] ?? null;
  if (!payerTin) {
    warnings.push('Every TIN in this PDF is truncated (XXX-XX-1234) — recipient copies mask TINs. Import needs full TINs: use the Copy 1/Copy C print, or fill TINs in during review.');
  } else if (byCount.length > 1 && byCount[0]![1] === byCount[1]![1] && byCount[0]![1] === 1) {
    warnings.push('Single form detected — payer/recipient assignment is by box order; verify during review.');
  }
  const extraPayers = byCount.filter(([, n]) => n > 1).slice(1);
  if (extraPayers.length > 0) {
    warnings.push(`More than one repeating TIN found (${extraPayers.map(([t]) => maskForWarning(t)).join(', ')}) — file may contain multiple payers; only the dominant one was parsed. Split the PDF per payer and re-import the rest.`);
  }

  // Walk payer-TIN anchors: payer info precedes the anchor, the recipient block
  // follows it. Amounts print wherever the filled box sits (before the payer
  // street, after the recipient TIN, …), so attribution uses the year lines that
  // open each form block: the first amount between this block's year line and
  // the next block's belongs to this form. No year lines -> no amount (never
  // misattribute a neighbor's).
  const yearIdxs: number[] = [];
  lines.forEach((l, i) => {
    if (YEAR_RE.test(l)) yearIdxs.push(i);
  });
  const blockAmount = (anchorIdx: number): string | null => {
    let start = -1;
    for (const y of yearIdxs) {
      if (y < anchorIdx) start = y;
      else break;
    }
    if (start < 0) return null;
    const end = yearIdxs.find((y) => y > anchorIdx) ?? lines.length;
    const hit = lines.slice(start + 1, end).find((l) => AMOUNT_RE.test(l));
    return hit ? hit.replace(/^\$/, '') : null;
  };

  let payer: ParsedParty | null = null;
  const recipients: ParsedRecipient[] = [];
  const seenRecipTins = new Set<string>();

  const payerAnchors = payerTin ? hits.filter(({ hit }) => hit.kind === 'full' && hit.tin === payerTin) : [];

  if (payerAnchors.length > 0) {
    const first = payerAnchors[0]!;
    // Payer block: lines before the first anchor — cut at the year line when the
    // print carries one (it opens each form block), else take everything, minus
    // amounts/TINs either way.
    let start = 0;
    for (let i = first.idx - 1; i >= 0; i--) {
      if (YEAR_RE.test(lines[i]!)) {
        start = i + 1;
        break;
      }
    }
    const before = lines.slice(start, first.idx).filter((l) => !YEAR_RE.test(l) && !AMOUNT_RE.test(l) && !classifyTin(l));
    payer = readParty(before, first.hit, warnings, 'Payer');

    for (const anchor of payerAnchors) {
      // Recipient TIN is the next TIN line after the payer anchor.
      const recipHit = hits.find(({ idx, hit }) => idx > anchor.idx && !(hit.kind === 'full' && hit.tin === payerTin));
      if (!recipHit || hits.some(({ idx, hit }) => idx > anchor.idx && idx < recipHit.idx && hit.kind === 'full' && hit.tin === payerTin)) continue;

      // Block body: lines after the recipient TIN up to the next year/TIN line.
      // Amount lines are skipped, not terminal — a filled box can print its
      // value right after the recipient TIN.
      const body: string[] = [];
      for (let i = recipHit.idx + 1; i < lines.length; i++) {
        const l = lines[i]!;
        if (YEAR_RE.test(l) || classifyTin(l)) break;
        if (AMOUNT_RE.test(l)) continue;
        body.push(l);
        if (CITY_STATE_ZIP_RE.test(l)) break;
      }
      const rec = readParty(body, recipHit.hit, warnings, `Recipient ${recipients.length + 1}`) as ParsedRecipient;
      rec.amount = blockAmount(anchor.idx);

      const dedupeKey = rec.tin || `masked:${rec.tinLast4}:${rec.name1}`;
      if (seenRecipTins.has(dedupeKey)) {
        warnings.push(`Recipient "${rec.name1}" appears more than once — kept the first occurrence.`);
        continue;
      }
      seenRecipTins.add(dedupeKey);
      recipients.push(rec);
    }
  } else {
    // All TINs masked: best-effort blocks so review still has names to work with.
    for (const { idx, hit } of hits) {
      const body: string[] = [];
      for (let i = idx + 1; i < lines.length; i++) {
        const l = lines[i]!;
        if (YEAR_RE.test(l) || AMOUNT_RE.test(l) || classifyTin(l)) break;
        body.push(l);
        if (CITY_STATE_ZIP_RE.test(l)) break;
      }
      const rec = readParty(body, hit, warnings, `Recipient ${recipients.length + 1}`) as ParsedRecipient;
      rec.amount = null;
      recipients.push(rec);
    }
  }

  if (recipients.length === 0) warnings.push('No recipient forms could be parsed out of this PDF.');
  return { taxYear, formType, payer, recipients, warnings };
}

function mode(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

/** Warnings may end up in UI text/logs — never put a full TIN in one. */
function maskForWarning(tin: string): string {
  return `***-${tin.replace(/\D/g, '').slice(-4)}`;
}
