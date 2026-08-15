/**
 * QA: drive the real TaxBanditsClient against the mock server to exercise the
 * whole chain — OAuth → wire conversion → Create → Transmit(release) → Status
 * polling → ack derivation. Run: pnpm --filter @vibe1099/worker mock-taxbandits   (in one shell)
 *      pnpm qa:taxbandits                             (in another)
 */
import { TaxBanditsClient, taxbanditsEndpoints } from '@vibe1099/core/taxbandits/client';
import { buildTaxBanditsPayload } from '@vibe1099/core/taxbandits/payload';
import type { IrisTransmissionInput, IrisFormRecord } from '@vibe1099/core/iris/xml';

const BASE = 'http://localhost:8301';

function rec(id: string, tin: string, box1: number, extra: Record<string, unknown> = {}): IrisFormRecord {
  return {
    recordId: id,
    formType: 'NEC',
    taxYear: 2025,
    recipient: { tin, tinType: 'SSN', name1: 'JORDAN ABLE', address: { line1: '1 Oak', city: 'KC', state: 'MO', zip: '64100' } },
    boxValues: { box1, ...extra },
  };
}

const input: IrisTransmissionInput = {
  utid: `QA-${Date.now()}`,
  tcc: '',
  taxYear: 2025,
  environment: 'ATS',
  transmitter: { tcc: '', tin: '431234567', tinType: 'EIN', name1: 'Firm', address: { line1: '1', city: 'KC', state: 'MO', zip: '64105' } },
  issuer: { tin: '431111111', tinType: 'EIN', name1: 'ACME LLC', address: { line1: '2', city: 'KC', state: 'MO', zip: '64106' }, phone: '8165551212' },
  records: [
    rec('rec-clean', '400111222', 1250000),
    rec('rec-state', '400111333', 900000, { stateCode: 'MO', stateTaxWithheld: 25000, stateIncome: 900000, statePayerStateNo: '87654321' }),
  ],
  cfsfStates: ['AR'],
  isCorrection: false,
};

const client = new TaxBanditsClient(taxbanditsEndpoints(BASE, `${BASE}/v2/tbsauth`), {
  clientId: 'qa-client',
  clientSecret: 'qa-secret',
  userToken: 'qa-token',
});

const payload = JSON.stringify(buildTaxBanditsPayload(input, 'sandbox', { postalMailing: false, onlineAccess: false }));

const fail: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fail.push(label);
};

const submission = await client.transmit(payload);
check('Create returns a SubmissionId', !!submission.providerRef, submission.providerRef);

// After transmit() the release must already have happened: a first poll should
// NOT report every record still CREATED.
const s1 = await client.status(submission.providerRef, { formType: 'NEC' });
check('poll 1 is non-terminal (in flight)', s1.status === 'Processing', s1.status);
check('poll 1 reports per-record status', (s1.records?.length ?? 0) === 2, JSON.stringify(s1.records));
check(
  'release happened at transmit — records are past CREATED',
  !(s1.records ?? []).every((r) => r.status.toUpperCase() === 'CREATED'),
  (s1.records ?? []).map((r) => r.status).join(', '),
);

const s2 = await client.status(submission.providerRef, { formType: 'NEC' });
check('poll 2 reaches a terminal verdict', ['Accepted', 'AcceptedWithErrors', 'Rejected'].includes(s2.status), s2.status);
check('terminal verdict carries per-record ids we can map back', (s2.records ?? []).every((r) => r.recordId.startsWith('rec-')), JSON.stringify(s2.records));

// unknown submission must be NotFound, not a crash
const s404 = await client.status('does-not-exist', { formType: 'NEC' });
check('unknown submission → NotFound', s404.status === 'NotFound', s404.status);

// credits
const credits = await client.credits();
check('credits returns integer cents', Number.isInteger(credits.balanceCents), String(credits.balanceCents));

// TIN matching round trip
const tin = await client.submitTinMatch({ sequenceId: 'recip-1', name: 'JORDAN ABLE', tin: '400111222', tinType: 'SSN' });
check('TIN match submit returns a submission id', !!tin.submissionId, tin.submissionId);
check('TIN match starts pending', tin.status === 'pending', tin.status);
await client.getTinMatchStatus(tin.submissionId);
const verdicts = await client.getTinMatchStatus(tin.submissionId);
check('TIN match resolves to a verdict', verdicts.every((v) => v.status !== 'pending'), JSON.stringify(verdicts));
check('TIN match verdict maps back to our recipient ref', verdicts.some((v) => v.recipientRef === 'recip-1'), JSON.stringify(verdicts.map((v) => v.recipientRef)));

console.log(fail.length ? `\n${fail.length} FAILURE(S): ${fail.join('; ')}` : '\nALL E2E CHECKS PASSED');
process.exit(fail.length ? 1 : 0);
