import { describe, expect, it } from 'vitest';
import { buildTaxBanditsPayload, toTaxBanditsWire } from '@vibe1099/core/taxbandits/payload';
import type { IrisTransmissionInput, IrisFormRecord } from '@vibe1099/core/iris/xml';

/**
 * State-filing policy: when an API provider is enabled it files BOTH federal
 * and state. The Missouri Pub 1220 direct-file path must then stand down for
 * those records, or Missouri receives the same return twice.
 */

function record(over: Partial<IrisFormRecord> = {}): IrisFormRecord {
  return {
    recordId: 'r1',
    formType: 'NEC',
    taxYear: 2025,
    recipient: {
      tin: '400111222',
      tinType: 'SSN',
      name1: 'JORDAN ABLE',
      address: { line1: '101 Oak St', city: 'Kansas City', state: 'MO', zip: '64100' },
    },
    boxValues: { box1: 1250000 },
    ...over,
  };
}

function input(records: IrisFormRecord[], cfsf: string[] = ['AR']): IrisTransmissionInput {
  return {
    utid: 'TB-1',
    tcc: '',
    taxYear: 2025,
    environment: 'ATS',
    transmitter: { tcc: '', tin: '431234567', tinType: 'EIN', name1: 'Firm', address: { line1: '1 A', city: 'KC', state: 'MO', zip: '64105' } },
    issuer: { tin: '431111111', tinType: 'EIN', name1: 'ACME LLC', address: { line1: '2 B', city: 'KC', state: 'MO', zip: '64106' } },
    records,
    cfsfStates: cfsf,
    isCorrection: false,
  };
}

const wireOf = (i: IrisTransmissionInput): any => toTaxBanditsWire(buildTaxBanditsPayload(i, 'sandbox'));

describe('provider state filing (TaxBandits wire)', () => {
  it('files federal on every submission', () => {
    expect(wireOf(input([record()])).SubmissionManifest.IsFederalFiling).toBe(true);
  });

  it('declares state filing and sends the state block when a record carries state data', () => {
    const w = wireOf(
      input([record({ boxValues: { box1: 1250000, stateCode: 'MO', stateTaxWithheld: 25000, stateIncome: 1250000, statePayerStateNo: '87654321' } })]),
    );
    expect(w.SubmissionManifest.IsStateFiling).toBe(true);
    expect(w.ReturnData[0].NECFormData.States[0]).toEqual({
      StateCd: 'MO',
      StateIdNum: '87654321',
      StateWH: 250,
      StateIncome: 12500,
    });
  });

  it('does NOT declare state filing when no record carries state data, even with a CF/SF election', () => {
    // regression: the CF/SF list is global (always populated), so keying
    // IsStateFiling off it made every submission claim state filing
    const w = wireOf(input([record()], ['AR', 'MO']));
    expect(w.SubmissionManifest.IsStateFiling).toBe(false);
    expect(w.ReturnData[0].NECFormData.States).toBeUndefined();
  });

  it('never schedules — filing is on demand', () => {
    const w = wireOf(input([record()]));
    expect(w.SubmissionManifest.IsScheduleFiling).toBe(false);
    expect(JSON.stringify(w)).not.toMatch(/EfileDate|EFilingDate/i);
  });
});

/** Mirrors statesFiledBy() in apps/api/src/services/iris.ts. */
function statesFiledBy(provider: 'iris' | 'tax1099' | 'taxbandits', records: IrisFormRecord[], elected: string[]): string[] {
  const onRecords = [
    ...new Set(records.map((r) => String(r.boxValues['stateCode'] ?? '').trim().toUpperCase()).filter((s) => s.length === 2)),
  ];
  if (provider === 'iris') return onRecords.filter((s) => elected.includes(s));
  return onRecords;
}

describe('statesFiled recording (drives the MO double-file guard)', () => {
  const moRecord = record({ boxValues: { box1: 1250000, stateCode: 'MO', stateTaxWithheld: 25000 } });

  it('API providers file every state present on the records', () => {
    expect(statesFiledBy('taxbandits', [moRecord], ['AR'])).toEqual(['MO']);
    expect(statesFiledBy('tax1099', [moRecord], ['AR'])).toEqual(['MO']);
  });

  it('IRIS files only CF/SF-elected states — MO is not elected, so it stays a direct file', () => {
    expect(statesFiledBy('iris', [moRecord], ['AR'])).toEqual([]);
    expect(statesFiledBy('iris', [moRecord], ['AR', 'MO'])).toEqual(['MO']);
  });

  it('records with no state data file no states', () => {
    expect(statesFiledBy('taxbandits', [record()], ['AR'])).toEqual([]);
  });
});

/** Mirrors the includability rule in apps/api/src/routes/mo.ts. */
function moIncludable(opts: { statesFiled: string[] | null; meetsThreshold: boolean; includeBelowThreshold: boolean }): boolean {
  const alreadyStateFiled = (opts.statesFiled ?? []).includes('MO');
  return !alreadyStateFiled && (opts.meetsThreshold || opts.includeBelowThreshold);
}

describe('MO Pub 1220 double-file guard', () => {
  it('excludes a record the provider already filed with Missouri', () => {
    expect(moIncludable({ statesFiled: ['MO'], meetsThreshold: true, includeBelowThreshold: false })).toBe(false);
  });

  it('the exclusion is absolute — includeBelowThreshold cannot pull it back in', () => {
    expect(moIncludable({ statesFiled: ['MO'], meetsThreshold: false, includeBelowThreshold: true })).toBe(false);
  });

  it('still includes records filed federally only (IRIS: MO not CF/SF-elected)', () => {
    expect(moIncludable({ statesFiled: [], meetsThreshold: true, includeBelowThreshold: false })).toBe(true);
  });

  it('treats pre-upgrade transmissions (unknown) as not state-filed, preserving prior behaviour', () => {
    expect(moIncludable({ statesFiled: null, meetsThreshold: true, includeBelowThreshold: false })).toBe(true);
  });

  it('a provider filing a different state does not exclude the MO file', () => {
    expect(moIncludable({ statesFiled: ['AR'], meetsThreshold: true, includeBelowThreshold: false })).toBe(true);
  });
});

/** Mirrors the states-filed backfill parsing in routes/iris.ts + the UI. */
function parseStatesInput(entered: string): string[] {
  return [...new Set(entered.split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.toUpperCase()))];
}

describe('historical states-filed backfill', () => {
  it('normalizes operator input to unique upper-case codes', () => {
    expect(parseStatesInput(' mo , MO,  ar ')).toEqual(['MO', 'AR']);
  });

  it('blank input means no states were provider-filed', () => {
    expect(parseStatesInput('')).toEqual([]);
  });

  it('backfilling MO removes the records from the MO file', () => {
    const before = moIncludable({ statesFiled: null, meetsThreshold: true, includeBelowThreshold: false });
    const after = moIncludable({ statesFiled: parseStatesInput('MO'), meetsThreshold: true, includeBelowThreshold: false });
    expect(before).toBe(true); // unknown history → still offered for upload
    expect(after).toBe(false); // recorded as provider-filed → excluded
  });

  it('backfilling "none" keeps the records available for the MO file', () => {
    expect(moIncludable({ statesFiled: parseStatesInput(''), meetsThreshold: true, includeBelowThreshold: false })).toBe(true);
  });
});
