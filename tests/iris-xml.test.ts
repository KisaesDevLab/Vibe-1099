import { describe, expect, it } from 'vitest';
import {
  buildTransmissionXml,
  generateUtid,
  preTransmitCheck,
  xmlEscape,
  type IrisTransmissionInput,
} from '@vibe1099/core/iris/xml';
import { extractAll, extractXmlValue } from '@vibe1099/core/iris/client';

const clientExtract = extractXmlValue;

function baseInput(overrides: Partial<IrisTransmissionInput> = {}): IrisTransmissionInput {
  return {
    utid: 'test-utid:SYS2:12ABC::T',
    tcc: '12ABC',
    taxYear: 2026,
    environment: 'ATS',
    transmitter: {
      tcc: '12ABC',
      tin: '431234567',
      tinType: 'EIN',
      name1: 'Demo CPA Firm LLC',
      address: { line1: '100 Main St', city: 'Kansas City', state: 'MO', zip: '64105' },
    },
    issuer: {
      tin: '431111111',
      tinType: 'EIN',
      name1: 'ACME & SONS <LLC>',
      address: { line1: '200 Commerce Way', city: 'Kansas City', state: 'MO', zip: '64106' },
    },
    records: [
      {
        recordId: 'rec-1',
        formType: 'NEC',
        taxYear: 2026,
        recipient: {
          tin: '400111222',
          tinType: 'SSN',
          name1: 'JORDAN ABLE',
          address: { line1: '101 Oak St', city: 'Kansas City', state: 'MO', zip: '64100' },
        },
        boxValues: { box1: 1250000, fedTaxWithheld: 50000, directSales: true, stateTaxWithheld: 25000, statePayerStateNo: '876', stateCode: 'MO' },
        accountNumber: 'NEC2026-001',
        secondTinNotice: true,
      },
    ],
    cfsfStates: ['AR'],
    isCorrection: false,
    ...overrides,
  };
}

describe('IRIS XML generation (registry-driven, Pub 5718 style)', () => {
  it('builds a schema-versioned transmission with manifest + submission', () => {
    const xml = buildTransmissionXml(baseInput());
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('schemaVersion="IRIS-TY2026-v1.0"');
    expect(extractXmlValue(xml, 'UniqueTransmissionId')).toBe('test-utid:SYS2:12ABC::T');
    expect(extractXmlValue(xml, 'TransmitterControlCd')).toBe('12ABC');
    expect(extractXmlValue(xml, 'TestFileCd')).toBe('T');
    expect(extractXmlValue(xml, 'TotalPayeeRecordCnt')).toBe('1');
  });

  it('money is decimal-string cents (never floats), checkboxes are 1, strings escaped', () => {
    const xml = buildTransmissionXml(baseInput());
    expect(xml).toContain('<NonemployeeCompensationAmt>12500.00</NonemployeeCompensationAmt>');
    expect(xml).toContain('<FederalIncomeTaxWithheldAmt>500.00</FederalIncomeTaxWithheldAmt>');
    expect(xml).toContain('<DirectSalesInd>1</DirectSalesInd>');
    expect(xml).toContain('<SecondTINNoticeInd>1</SecondTINNoticeInd>');
    expect(xml).toContain('ACME &amp; SONS &lt;LLC&gt;'); // escaping
  });

  it('state boxes nest in StateLocalTaxGrp', () => {
    const xml = buildTransmissionXml(baseInput());
    const group = extractAll(xml, 'StateLocalTaxGrp')[0] ?? '';
    expect(group).toContain('<StateTaxWithheldAmt>250.00</StateTaxWithheldAmt>');
    expect(group).toContain('<StateAbbreviationCd>MO</StateAbbreviationCd>');
  });

  it('CF/SF election lists participating states (AR code 05 benefit)', () => {
    const xml = buildTransmissionXml(baseInput());
    expect(xml).toContain('<ParticipatingStateCd>AR</ParticipatingStateCd>');
  });

  it('corrections carry indicators: G for zero/void, C for replacement', () => {
    const input = baseInput();
    input.records[0]!.corrected = true;
    input.records[0]!.correctionKind = 'two_transaction_zero';
    input.records[0]!.originalRecordId = 'orig-1';
    const xml = buildTransmissionXml(input);
    expect(xml).toContain('<CorrectedInd>1</CorrectedInd>');
    expect(xml).toContain('<CorrectedReturnIndicatorCd>G</CorrectedReturnIndicatorCd>');
    expect(extractXmlValue(xml, 'OriginalRecordId')).toBe('orig-1');

    input.records[0]!.correctionKind = 'two_transaction_new';
    expect(buildTransmissionXml(input)).toContain('<CorrectedReturnIndicatorCd>C</CorrectedReturnIndicatorCd>');
  });

  it('zeroed correction amounts still serialize (0.00 must appear)', () => {
    const input = baseInput();
    input.records[0]!.corrected = true;
    input.records[0]!.correctionKind = 'void';
    input.records[0]!.boxValues = { box1: 0, fedTaxWithheld: 0 };
    const xml = buildTransmissionXml(input);
    expect(xml).toContain('<NonemployeeCompensationAmt>0.00</NonemployeeCompensationAmt>');
  });

  it('UTID format: uuid:SYS2:TCC::T|P', () => {
    expect(generateUtid('12ABC', 'ATS')).toMatch(/^[0-9a-f-]{36}:SYS2:12ABC::T$/);
    expect(generateUtid('12ABC', 'PROD')).toMatch(/::P$/);
  });

  it('pre-transmit checks catch bad TINs, missing TCC, empty batches', () => {
    expect(preTransmitCheck(baseInput({ tcc: '' }))).toContainEqual(expect.stringContaining('TCC'));
    expect(preTransmitCheck(baseInput({ records: [] }))).toContainEqual(expect.stringContaining('No records'));
    const bad = baseInput();
    bad.records[0]!.recipient.tin = '12345';
    expect(preTransmitCheck(bad).some((p) => p.includes('not 9 digits'))).toBe(true);
    expect(preTransmitCheck(baseInput())).toHaveLength(0);
  });

  it('xmlEscape covers the five', () => {
    expect(xmlEscape(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&apos;');
  });

  it('client ack parsing helpers', () => {
    const ack = '<StatusResponse><ReceiptId>MOCK-1</ReceiptId><TransmissionStatusCd>Accepted</TransmissionStatusCd></StatusResponse>';
    expect(clientExtract(ack, 'ReceiptId')).toBe('MOCK-1');
    expect(clientExtract(ack, 'TransmissionStatusCd')).toBe('Accepted');
  });
});
