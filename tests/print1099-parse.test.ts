import { describe, expect, it } from 'vitest';
import { parse1099Print } from '@vibe1099/core';

// Fixture mirrors the text layer of a real 3-up "Copy 1" 1099-NEC print PDF
// (template boilerplate first, then the filled values in generator order:
// year, payer block, amount, payer TIN, recipient TIN, recipient block).
// All TINs/names here are fabricated.
const NEC_BOILER = `Form 1099-NEC Nonemployee
Compensation
Copy 1
For State Tax
Department
Department of the Treasury - Internal Revenue Service
OMB No. 1545-0116
For calendar year
VOID CORRECTED
PAYER’S name, street address, city or town, state or province, country, ZIP
or foreign postal code, and telephone no.
PAYER’S TIN RECIPIENT’S TIN
RECIPIENT’S name
Street address (including apt. no.)
City or town, state or province, country, and ZIP or foreign postal code
Account number (see instructions)
1 Nonemployee compensation
$
2 Payer made direct sales totaling $5,000 or more of
consumer products to recipient for resale
4 Federal income tax withheld
$
5 State tax withheld
$
$
6 State/Payer’s state no. 7 State income
$
$
www.irs.gov/Form1099NEC
(Rev. April 2025)
Form 1099-NEC (Rev. 4-2025)
$
3 Excess golden parachute payments`;

function block(payer: string[], amount: string, payerTin: string, recipTin: string, recip: string[]): string {
  return ['2025', ...payer, amount, payerTin, recipTin, ...recip].join('\n');
}

const PAYER = ['Acme Surfaces LLC', '1300 W. Example Rd., Suite 8', 'Rogers, AR 72756'];

const PAGE_1 = [
  NEC_BOILER,
  block(PAYER, '9750.00', '46-1234567', '211-43-6789', ['Jane  Doe', '514 Sample Rd Apt 201', 'Springdale,AR 72764']),
  block(PAYER, '246626.55', '46-1234567', '92-7654321', ['Delta Cleaning Services, LLC', '300 Test Rd', 'Rogers,AR 72756']),
  block(PAYER, '94984.92', '46-1234567', '93-1111222', ['Echo Remodeling', '5325 N Oak St, Apt D-303', 'Springdale,AR 72764']),
].join('\n');

const PAGE_2 = [
  NEC_BOILER,
  block(PAYER, '2100.70', '46-1234567', '33-3334444', ['Foxtrot Flooring', 'PO Box 6771', 'Springdale,AR 72766']),
].join('\n');

describe('parse1099Print — 3-up NEC print PDF', () => {
  const p = parse1099Print([PAGE_1, PAGE_2]);

  it('detects form type and tax year', () => {
    expect(p.formType).toBe('NEC');
    expect(p.taxYear).toBe(2025);
  });

  it('identifies the payer by TIN repetition and reads its block', () => {
    expect(p.payer?.tin).toBe('46-1234567');
    expect(p.payer?.tinType).toBe('EIN');
    expect(p.payer?.name1).toBe('Acme Surfaces LLC');
    expect(p.payer?.address).toMatchObject({ city: 'Rogers', state: 'AR', zip: '72756' });
    // payer street keeps its suite on the same line pair
    expect(p.payer?.address?.line1).toBe('1300 W. Example Rd.');
    expect(p.payer?.address?.line2).toBe('Suite 8');
  });

  it('parses every recipient across pages, in order', () => {
    expect(p.recipients.map((r) => r.name1)).toEqual([
      'Jane Doe', // double space collapsed
      'Delta Cleaning Services, LLC',
      'Echo Remodeling',
      'Foxtrot Flooring',
    ]);
  });

  it('assigns TIN types from the printed format', () => {
    expect(p.recipients[0]).toMatchObject({ tin: '211-43-6789', tinType: 'SSN', tinMasked: false, tinLast4: '6789' });
    expect(p.recipients[1]).toMatchObject({ tin: '92-7654321', tinType: 'EIN' });
  });

  it('splits an inline unit into address line2 and handles PO boxes', () => {
    expect(p.recipients[2]?.address).toMatchObject({ line1: '5325 N Oak St', line2: 'Apt D-303', city: 'Springdale', state: 'AR', zip: '72764' });
    expect(p.recipients[3]?.address).toMatchObject({ line1: 'PO Box 6771', zip: '72766' });
  });

  it('attributes the nearby printed amount (display-only)', () => {
    expect(p.recipients.map((r) => r.amount)).toEqual(['9750.00', '246626.55', '94984.92', '2100.70']);
  });

  it('is clean of warnings on a well-formed print', () => {
    expect(p.warnings).toEqual([]);
  });
});

// Second generator style (2-up 1099-MISC): phone line in the payer block, blank
// filler lines, "14" orphan box labels, and the filled amount printing in
// box-dependent positions — between payer name and street on one form, right
// after the recipient TIN on the next.
const MISC_BOILER = `Form 1099-MISC Miscellaneous
Information
Copy 1
For State Tax
Department
Department of the Treasury - Internal Revenue Service
OMB No. 1545-0115
For calendar year
VOID CORRECTED
PAYER’S name, street address, city or town, state or province, country, ZIP
or foreign postal code, and telephone no.
PAYER’S TIN RECIPIENT’S TIN
RECIPIENT’S name
1 Rents
$
2 Royalties
$
3 Other income
$
7 Payer made direct sales
totaling $5,000 or more of
consumer products to
recipient for resale
10 Gross proceeds paid to an
attorney
$
www.irs.gov/Form1099MISC
(Rev. April 2025)
Form 1099-MISC (Rev. 4-2025)
14
14 `;

const MISC_PAGE = [
  MISC_BOILER,
  '2025', 'Sample Farm LLC', '1620.00', '17632 Highway 12', 'Wentworth, MO 64873', '417-555-1955', ' ',
  '83-7654321', '496-11-2222', ' ', 'June  Poe', ' ', '2734 E Sample Road', 'Springfield,MO 65804', ' ',
  '2025', 'Sample Farm LLC', '17632 Highway 12', 'Wentworth, MO 64873', '417-555-1955', ' ',
  '83-7654321', '86-3334444', ' 12339.90', 'Heritage Vet Partners, PC', ' ', 'dba Animal Clinic of Monett', '450 E Sample St', 'West Point,NE 68788', ' ',
].join('\n');

describe('parse1099Print — 2-up MISC print PDF (second generator)', () => {
  const p = parse1099Print([MISC_PAGE]);

  it('detects MISC and the payer despite the phone line', () => {
    expect(p.formType).toBe('MISC');
    expect(p.payer).toMatchObject({ tin: '83-7654321', tinType: 'EIN', name1: 'Sample Farm LLC' });
    expect(p.payer?.address).toMatchObject({ line1: '17632 Highway 12', city: 'Wentworth', state: 'MO', zip: '64873' });
  });

  it('reads both recipients, including a dba second name line', () => {
    expect(p.recipients).toHaveLength(2);
    expect(p.recipients[0]).toMatchObject({ tin: '496-11-2222', tinType: 'SSN', name1: 'June Poe' });
    expect(p.recipients[1]).toMatchObject({ tin: '86-3334444', tinType: 'EIN', name1: 'Heritage Vet Partners, PC', name2: 'dba Animal Clinic of Monett' });
    expect(p.recipients[1]?.address).toMatchObject({ line1: '450 E Sample St', city: 'West Point', state: 'NE', zip: '68788' });
  });

  it('attributes amounts by form-block span regardless of box position', () => {
    expect(p.recipients.map((r) => r.amount)).toEqual(['1620.00', '12339.90']);
  });
});

// Third generator style ("PrintForm1099" data-only overlay for preprinted
// stock): NO template boilerplate at all — just the filled values, 3-up (NEC)
// or 2-up (MISC). Payer block carries a phone line; the amount prints before
// the payer TIN on NEC and between payer name and street on MISC; MISC pages
// interleave single-space filler lines. Form type is undetectable (nothing in
// the text names the form) and must come back null, not misguessed.
const OVERLAY_NEC_PAGE = [
  '2025', 'Sample Grower', '11111 County Road 1000', 'Pierce City, MO 65723', '417-555-0100',
  '1320.00', '43-7654321', '400-11-2222', 'Alpha  Tester', '22222 County Road 1070', 'Pierce City,MO 65723',
  '2025', 'Sample Grower', '11111 County Road 1000', 'Pierce City, MO 65723', '417-555-0100',
  '2275.06', '43-7654321', '400-33-4444', 'Beta  Tester JR', 'Tester Farm', '33333 Newton Rd', 'Newton,MO 64862',
].join('\n');

const OVERLAY_MISC_PAGE = [
  '2025', 'Sample Grower', '3000.00', '11111 County Road 1000', 'Pierce City, MO 65723', '417-555-0100', ' ',
  '43-7654321', '400-55-6666', ' ', 'Gamma  Tester', ' ', '44444 County Road 1050', 'Wentworth,MO 64873', ' ',
  '2025', 'Sample Grower', '2250.00', '11111 County Road 1000', 'Pierce City, MO 65723', '417-555-0100', ' ',
  '43-7654321', '400-77-8888', ' ', 'Delta  Tester', ' ', '55555 Hwy 97', 'Pierce City,MO 65723', ' ',
].join('\n');

describe('parse1099Print — data-only overlay print (no template text)', () => {
  it('parses the 3-up NEC-style overlay: payer with phone line, recipients, amounts', () => {
    const p = parse1099Print([OVERLAY_NEC_PAGE]);
    expect(p.taxYear).toBe(2025);
    expect(p.formType).toBeNull(); // nothing in the text names the form
    expect(p.payer).toMatchObject({ tin: '43-7654321', tinType: 'EIN', name1: 'Sample Grower' });
    expect(p.payer?.address).toMatchObject({ line1: '11111 County Road 1000', city: 'Pierce City', state: 'MO', zip: '65723' });
    expect(p.recipients).toHaveLength(2);
    expect(p.recipients[0]).toMatchObject({ tin: '400-11-2222', tinType: 'SSN', name1: 'Alpha Tester', amount: '1320.00' });
    expect(p.recipients[1]).toMatchObject({ name1: 'Beta Tester JR', name2: 'Tester Farm', amount: '2275.06' });
    expect(p.warnings).toEqual([]);
  });

  it('parses the 2-up MISC-style overlay: amount between payer name and street', () => {
    const p = parse1099Print([OVERLAY_MISC_PAGE]);
    expect(p.payer).toMatchObject({ tin: '43-7654321', name1: 'Sample Grower' });
    expect(p.recipients).toHaveLength(2);
    expect(p.recipients[0]).toMatchObject({ tin: '400-55-6666', tinType: 'SSN', name1: 'Gamma Tester', amount: '3000.00' });
    expect(p.recipients[0]?.address).toMatchObject({ line1: '44444 County Road 1050', city: 'Wentworth', state: 'MO', zip: '64873' });
    expect(p.recipients[1]).toMatchObject({ tin: '400-77-8888', name1: 'Delta Tester', amount: '2250.00' });
    expect(p.warnings).toEqual([]);
  });
});

describe('parse1099Print — edge cases', () => {
  it('resolves bare 9-digit TINs from the name shape, with a warning', () => {
    const page = [NEC_BOILER, block(PAYER, '100.00', '46-1234567', '921234567', ['Gulf Services LLC', '1 Main St', 'Rogers,AR 72756']), block(PAYER, '50.00', '46-1234567', '123456789', ['John Smith', '2 Main St', 'Rogers,AR 72756'])].join('\n');
    const p = parse1099Print([page]);
    expect(p.recipients[0]?.tinType).toBe('EIN');
    expect(p.recipients[1]?.tinType).toBe('SSN');
    expect(p.warnings.some((w) => w.includes('without separators'))).toBe(true);
  });

  it('flags masked recipient-copy TINs and keeps names for review', () => {
    const page = [NEC_BOILER, '2025', ...PAYER, '100.00', 'XXX-XX-1234', 'Jane Doe', '1 Main St', 'Rogers,AR 72756'].join('\n');
    const p = parse1099Print([page]);
    expect(p.warnings.some((w) => w.includes('truncated'))).toBe(true);
    expect(p.recipients[0]).toMatchObject({ tin: '', tinMasked: true, tinLast4: '1234', name1: 'Jane Doe' });
  });

  it('reports an image-only PDF (empty text layer) instead of failing silently', () => {
    const p = parse1099Print(['', '', '']);
    expect(p.payer).toBeNull();
    expect(p.recipients).toEqual([]);
    expect(p.warnings.some((w) => w.includes('scanned/image PDF'))).toBe(true);
  });

  it('warns when a second repeating TIN suggests multiple payers', () => {
    const page = [
      NEC_BOILER,
      block(PAYER, '10.00', '46-1234567', '211-43-6789', ['Jane Doe', '1 Main St', 'Rogers,AR 72756']),
      block(PAYER, '20.00', '46-1234567', '92-7654321', ['Delta LLC', '2 Main St', 'Rogers,AR 72756']),
      block(['Other Payer Inc', '9 Oak Ave', 'Tulsa, OK 74101'], '30.00', '81-9998888', '211-43-0000', ['Sam Roe', '3 Main St', 'Tulsa,OK 74101']),
      block(['Other Payer Inc', '9 Oak Ave', 'Tulsa, OK 74101'], '40.00', '81-9998888', '211-43-1111', ['Kim Poe', '4 Main St', 'Tulsa,OK 74101']),
    ].join('\n');
    const p = parse1099Print([page]);
    expect(p.payer?.tin).toBe('46-1234567');
    expect(p.warnings.some((w) => w.includes('multiple payers'))).toBe(true);
    // and the warning must not leak a full TIN
    expect(p.warnings.join(' ')).not.toContain('81-9998888');
  });

  it('dedupes a recipient printed twice (multi-copy PDFs)', () => {
    const b = block(PAYER, '10.00', '46-1234567', '211-43-6789', ['Jane Doe', '1 Main St', 'Rogers,AR 72756']);
    const p = parse1099Print([[NEC_BOILER, b, b].join('\n')]);
    expect(p.recipients).toHaveLength(1);
    expect(p.warnings.some((w) => w.includes('more than once'))).toBe(true);
  });
});
