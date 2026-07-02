/**
 * IRIS XML generation (Pub 5718) — registry-driven, schema version pinned per
 * tax year. Element naming mirrors the IRIS XSD; the bundled XSD (when present
 * under packages/core/xsd/<taxYear>/) is used for a validation pass before
 * transmit via the render sidecar's lxml endpoint.
 *
 * Money: decimal strings from integer cents (ADR-001).
 */
import { randomUUID } from 'node:crypto';
import {
  centsToDecimalString,
  getFormDef,
  type FormType,
  type FormRecordValues,
} from '@vibe1099/shared';

export const IRIS_SCHEMA_VERSIONS: Record<number, string> = {
  2025: 'IRIS-TY2025-v1.0',
  2026: 'IRIS-TY2026-v1.0',
};

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function el(name: string, content: string | undefined | null, attrs?: Record<string, string>): string {
  if (content == null || content === '') return '';
  const attrStr = attrs ? ' ' + Object.entries(attrs).map(([k, v]) => `${k}="${xmlEscape(v)}"`).join(' ') : '';
  return `<${name}${attrStr}>${content}</${name}>`;
}

function elText(name: string, content: string | undefined | null): string {
  return content == null || content === '' ? '' : el(name, xmlEscape(content));
}

export interface IrisParty {
  tin: string; // plaintext digits — only ever serialized into the transmission XML
  tinType: 'SSN' | 'EIN';
  name1: string;
  name2?: string;
  address: { line1: string; line2?: string; city: string; state: string; zip: string };
  phone?: string;
}

export interface IrisFormRecord {
  recordId: string; // form_record uuid
  formType: FormType;
  taxYear: number;
  recipient: IrisParty;
  boxValues: FormRecordValues;
  accountNumber?: string;
  secondTinNotice?: boolean;
  /** corrections */
  corrected?: boolean;
  correctionKind?: 'one_transaction' | 'two_transaction_zero' | 'two_transaction_new' | 'void';
  originalRecordId?: string;
}

export interface IrisTransmissionInput {
  utid: string;
  tcc: string;
  taxYear: number;
  environment: 'ATS' | 'PROD';
  transmitter: IrisParty & { tcc: string };
  issuer: IrisParty; // the payer
  records: IrisFormRecord[];
  cfsfStates: string[]; // CF/SF election (participating states; AR code 05 benefits automatically)
  isCorrection: boolean;
}

/** UTID per Pub 5718: UUID:SYS2:TCC::T|P */
export function generateUtid(tcc: string, environment: 'ATS' | 'PROD'): string {
  return `${randomUUID()}:SYS2:${tcc}::${environment === 'ATS' ? 'T' : 'P'}`;
}

function partyXml(wrapper: string, p: IrisParty): string {
  return el(
    wrapper,
    [
      elText('TIN', p.tin),
      elText('TINTypeCd', p.tinType),
      elText('BusinessNameLine1Txt', p.name1),
      elText('BusinessNameLine2Txt', p.name2 ?? ''),
      el(
        'MailingAddressGrp',
        [
          elText('AddressLine1Txt', p.address.line1),
          elText('AddressLine2Txt', p.address.line2 ?? ''),
          elText('CityNm', p.address.city),
          elText('StateAbbreviationCd', p.address.state),
          elText('ZIPCd', p.address.zip),
        ].join(''),
      ),
      elText('PhoneNum', p.phone ?? ''),
    ].join(''),
  );
}

function formDetailXml(rec: IrisFormRecord): string {
  const def = getFormDef(rec.formType, rec.taxYear);
  const parts: string[] = [];

  if (rec.corrected) {
    parts.push(el('CorrectedInd', '1'));
    if (rec.correctionKind === 'two_transaction_zero' || rec.correctionKind === 'void') {
      parts.push(el('CorrectedReturnIndicatorCd', 'G')); // zeroing / void transaction
    } else if (rec.correctionKind === 'two_transaction_new') {
      parts.push(el('CorrectedReturnIndicatorCd', 'C'));
    }
    if (rec.originalRecordId) parts.push(elText('OriginalRecordId', rec.originalRecordId));
  }

  parts.push(elText('AccountNum', rec.accountNumber ?? ''));
  if (rec.secondTinNotice) parts.push(el('SecondTINNoticeInd', '1'));
  parts.push(partyXml('RecipientDetail', rec.recipient));

  // registry-driven box mapping
  const stateParts: string[] = [];
  for (const box of def.boxes) {
    if (!box.irisElement) continue;
    const v = rec.boxValues[box.id];
    if (v == null) continue;
    let xml = '';
    if (box.kind === 'cents' && typeof v === 'number' && (v > 0 || rec.corrected)) {
      xml = el(box.irisElement, centsToDecimalString(v));
    } else if (box.kind === 'checkbox' && v === true) {
      xml = el(box.irisElement, '1');
    } else if ((box.kind === 'string' || box.kind === 'code') && typeof v === 'string' && v !== '') {
      xml = elText(box.irisElement, v);
    }
    if (!xml) continue;
    if (box.stateField) stateParts.push(xml);
    else parts.push(xml);
  }
  if (stateParts.length) parts.push(el('StateLocalTaxGrp', stateParts.join('')));

  return el(`${def.irisFormType}Detail`, parts.join(''), { recordId: rec.recordId });
}

export function buildTransmissionXml(input: IrisTransmissionInput): string {
  const schemaVersion = IRIS_SCHEMA_VERSIONS[input.taxYear] ?? `IRIS-TY${input.taxYear}-v1.0`;
  const manifest = el(
    'TransmissionManifest',
    [
      elText('UniqueTransmissionId', input.utid),
      elText('TransmitterControlCd', input.tcc),
      elText('TestFileCd', input.environment === 'ATS' ? 'T' : 'P'),
      el('TransmissionTypeCd', input.isCorrection ? 'C' : 'O'),
      elText('TaxYr', String(input.taxYear)),
      partyXml('TransmitterDetail', input.transmitter),
      el('TotalPayeeRecordCnt', String(input.records.length)),
    ].join(''),
  );

  const cfsf = input.cfsfStates.length
    ? el('CFSFElectionGrp', input.cfsfStates.map((s) => elText('ParticipatingStateCd', s)).join(''))
    : '';

  const submission = el(
    'IRSubmission1Grp',
    [
      elText('SubmissionId', '1'),
      elText('TaxYr', String(input.taxYear)),
      partyXml('IssuerDetail', input.issuer),
      cfsf,
      ...input.records.map(formDetailXml),
    ].join(''),
  );

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<IRTransmission xmlns="urn:us:gov:treasury:irs:ir" schemaVersion="${xmlEscape(schemaVersion)}">` +
    manifest +
    submission +
    `</IRTransmission>`
  );
}

/**
 * Structural pre-transmit validation (registry-driven). Bundled-XSD validation
 * additionally runs via the render sidecar when an XSD exists for the year.
 */
export function preTransmitCheck(input: IrisTransmissionInput): string[] {
  const problems: string[] = [];
  if (!input.tcc || input.tcc.length < 5) problems.push('TCC missing or too short (Settings → IRIS)');
  if (!input.records.length) problems.push('No records in submission');
  if (input.records.length > 10_000) problems.push('Submission exceeds record cap — split the batch');
  for (const r of input.records) {
    if (!/^\d{9}$/.test(r.recipient.tin)) problems.push(`Record ${r.recordId}: recipient TIN is not 9 digits`);
    if (!r.recipient.name1) problems.push(`Record ${r.recordId}: recipient name missing`);
    if (!r.recipient.address.zip) problems.push(`Record ${r.recordId}: recipient ZIP missing`);
    try {
      getFormDef(r.formType, r.taxYear);
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  const xml = buildTransmissionXml(input);
  if (Buffer.byteLength(xml, 'utf8') > 100 * 1024 * 1024) problems.push('Transmission exceeds IRIS 100MB limit');
  return problems;
}
