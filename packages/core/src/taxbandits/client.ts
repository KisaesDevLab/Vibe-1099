/**
 * TaxBandits (SPAN Enterprises) REST client — implements FilingProvider (submit +
 * status) plus add-ons: real-time TIN matching, correction/void transmit, and
 * prepaid-credit balance. Bearer-token auth (see ./auth.ts). Base URL is
 * env-selected (mock | sandbox | prod).
 *
 * Endpoint paths + the response envelope follow the TaxBandits Developer Console
 * contract; they are centralized here and in ./payload.ts so the live wire-up is a
 * localized change. The mock server mirrors these shapes.
 */
import { AppError, ErrorCodes } from '@vibe1099/shared';
import type { RecordError, IrisAckStatus } from '../iris/client.js';
import type { FilingProvider, FilingStatusResult, FilingTransmitResult } from '../filing/provider.js';
import { toTaxBanditsWire, type TaxBanditsPayload } from './payload.js';
import { TaxBanditsAuth, type TaxBanditsCredentials } from './auth.js';

export interface TaxBanditsEndpoints {
  base: string;
  tokenUrl: string;
  tinMatchUrl: string;
  tinMatchStatusUrl: string;
  creditsUrl: string;
  /** Create/Status/Correction are PER FORM TYPE (Form1099NEC, Form1099MISC, …). */
  formUrl(formType: string, action: 'Create' | 'Status' | 'Correction'): string;
}

export function taxbanditsEndpoints(base: string, oauthUrl: string): TaxBanditsEndpoints {
  const b = base.replace(/\/$/, '');
  return {
    base: b,
    // OAuth token server is a separate host (expressauth.net), passed in.
    tokenUrl: oauthUrl,
    tinMatchUrl: `${b}/v1.7.3/TINMatchingRecipients/Request`,
    tinMatchStatusUrl: `${b}/v1.7.3/TINMatchingRecipients/Status`,
    creditsUrl: `${b}/v1.7.3/Account/GetCredits`,
    formUrl: (formType, action) => `${b}/v1.7.3/Form1099${formType.toUpperCase()}/${action}`,
  };
}

/** Normalized TIN-match verdict. TaxBandits TIN matching is asynchronous: a submit
 *  returns a SubmissionId and per-record refs with an initial "Order Created"
 *  status; the Success/Failed verdict is fetched later via getTinMatchStatus. */
export type TinMatchStatus = 'pending' | 'match' | 'mismatch' | 'error';

export interface TinMatchSubmitResult {
  submissionId: string;
  recordId: string;
  status: TinMatchStatus;
  raw: string;
}

export interface TinMatchStatusResult {
  recordId: string;
  recipientRef: string;
  status: TinMatchStatus;
  rawStatus: string;
}

export interface TinMatchRecipientInput {
  sequenceId: string; // our recipient id — echoed back to correlate the verdict
  name: string;
  tin: string;
  tinType: 'SSN' | 'EIN';
}

/** Map a TaxBandits TIN-match status string to our normalized verdict. */
export function normalizeTinMatchStatus(s: string): TinMatchStatus {
  const t = s.trim().toLowerCase();
  if (t === 'success') return 'match';
  if (t === 'failed') return 'mismatch';
  if (t === 'canceled' || t === 'cancelled') return 'error';
  return 'pending'; // Order Created | Under Process | Sent to Agency
}

export interface CreditBalance {
  balanceCents: number; // prepaid credit balance in integer cents
  raw: string;
}

/**
 * Per-record FEDERAL status → ack bucket (developer.taxbandits.com Status
 * contract). CREATED / TRANSMITTED / SENT TO AGENCY / UNDER PROCESS /
 * YET_TO_RETRANSMIT are all NON-terminal: "TRANSMITTED" means in flight to the
 * IRS, never accepted — treating it as accepted would lock records that the
 * IRS can still reject.
 */
function recordAck(s: string): 'accepted' | 'awe' | 'rejected' | 'processing' {
  const t = s.trim().toLowerCase().replace(/[\s_]+/g, '');
  if (t === 'accepted') return 'accepted';
  if (t === 'acceptedwitherrors') return 'awe';
  if (t === 'rejected') return 'rejected';
  return 'processing';
}

interface TbStatusError {
  Id?: string;
  Code?: string;
  Name?: string;
  Message?: string;
}
interface TbStatusRecord {
  RecordId?: string;
  PayeeRef?: string;
  FederalReturn?: { Status?: string; Errors?: TbStatusError[] | null } | null;
  Errors?: TbStatusError[] | null;
}

export class TaxBanditsClient implements FilingProvider {
  readonly kind = 'taxbandits' as const;
  private readonly auth: TaxBanditsAuth;

  constructor(
    private readonly endpoints: TaxBanditsEndpoints,
    creds: TaxBanditsCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.auth = new TaxBanditsAuth(endpoints.tokenUrl, creds, fetchImpl);
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    const token = await this.auth.accessToken();
    try {
      return await this.fetchImpl(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new AppError(ErrorCodes.E_IRIS, `TaxBandits request failed: ${(err as Error).message}`, 502);
    }
  }

  private parseSubmission(raw: string): FilingTransmitResult {
    let body: {
      SubmissionId?: string;
      submissionId?: string;
      Form1099Records?: { ErrorRecords?: TbStatusRecord[] | null } | null;
    };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      throw new AppError(ErrorCodes.E_IRIS, 'TaxBandits response was not JSON', 502, { raw });
    }
    // A 200 Create can still carry per-record validation failures under
    // ErrorRecords. Those records would never exist in the submission, so a
    // later ack would silently "accept" them — fail the whole transmit instead
    // (at-most-once handling returns the records to queued for the operator).
    const errorRecords = body.Form1099Records?.ErrorRecords ?? [];
    if (errorRecords.length) {
      throw new AppError(ErrorCodes.E_IRIS, `TaxBandits rejected ${errorRecords.length} record(s) at create`, 502, { raw });
    }
    const ref = body.SubmissionId ?? body.submissionId;
    if (!ref) throw new AppError(ErrorCodes.E_IRIS, 'TaxBandits response missing SubmissionId', 502, { raw });
    return { providerRef: ref, raw };
  }

  /** Stored payloads are our provider-neutral shape; convert to their wire
   *  contract ({SubmissionManifest, ReturnHeader, ReturnData}) and route to the
   *  form-typed endpoint. */
  private toWire(payloadJson: string): { formType: string; body: string } {
    let neutral: TaxBanditsPayload;
    try {
      neutral = JSON.parse(payloadJson) as TaxBanditsPayload;
    } catch {
      throw new AppError(ErrorCodes.E_IRIS, 'TaxBandits payload is not valid JSON', 500);
    }
    const formType = neutral.records[0]?.formType ?? 'NEC';
    return { formType, body: JSON.stringify(toTaxBanditsWire(neutral)) };
  }

  async transmit(payloadJson: string): Promise<FilingTransmitResult> {
    const { formType, body } = this.toWire(payloadJson);
    const res = await this.call(this.endpoints.formUrl(formType, 'Create'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const raw = await res.text();
    if (!res.ok) throw new AppError(ErrorCodes.E_IRIS, `TaxBandits create rejected (${res.status})`, 502, { raw });
    return this.parseSubmission(raw);
  }

  /** Corrections/voids go through the correction endpoint but return the same ref shape. */
  async transmitCorrection(payloadJson: string): Promise<FilingTransmitResult> {
    const { formType, body } = this.toWire(payloadJson);
    const res = await this.call(this.endpoints.formUrl(formType, 'Correction'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const raw = await res.text();
    if (!res.ok) throw new AppError(ErrorCodes.E_IRIS, `TaxBandits correction rejected (${res.status})`, 502, { raw });
    return this.parseSubmission(raw);
  }

  async status(submissionId: string, opts?: { formType?: string }): Promise<FilingStatusResult> {
    const res = await this.call(`${this.endpoints.formUrl(opts?.formType ?? 'NEC', 'Status')}?SubmissionId=${encodeURIComponent(submissionId)}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    const raw = await res.text();
    if (res.status === 404) return { status: 'NotFound', errors: [], raw };
    if (!res.ok) throw new AppError(ErrorCodes.E_IRIS, `TaxBandits status failed (${res.status})`, 502, { raw });
    // Real contract: NO top-level status. The submission verdict is derived from
    // each record's FederalReturn.Status under Form1099Records.SuccessRecords;
    // create-time failures appear under ErrorRecords (treated as rejected).
    // State-return statuses are informational here — the federal status drives
    // the record status machine.
    const body = JSON.parse(raw) as {
      Form1099Records?: { SuccessRecords?: TbStatusRecord[] | null; ErrorRecords?: TbStatusRecord[] | null } | null;
    };
    const success = body.Form1099Records?.SuccessRecords ?? [];
    const failed = body.Form1099Records?.ErrorRecords ?? [];
    if (!success.length && !failed.length) return { status: 'Processing', errors: [], raw };

    const errors: RecordError[] = [];
    const buckets = { accepted: 0, awe: 0, rejected: 0, processing: 0 };
    const pushErrors = (r: TbStatusRecord, list: TbStatusError[] | null | undefined) => {
      const recordId = r.PayeeRef ?? r.RecordId ?? '';
      let pushed = 0;
      for (const e of list ?? []) {
        errors.push({ recordId, code: e.Id ?? e.Code ?? 'UNKNOWN', message: e.Message ?? e.Name ?? '' });
        pushed++;
      }
      // applyAckToRecords rejects by error presence — a rejected record with no
      // detail from the agency still needs an error row or it would lock accepted.
      if (!pushed) errors.push({ recordId, code: 'REJECTED', message: 'Rejected by the agency (no error detail provided)' });
    };
    for (const r of success) {
      const ack = recordAck(r.FederalReturn?.Status ?? '');
      buckets[ack]++;
      if (ack === 'rejected' || ack === 'awe') pushErrors(r, r.FederalReturn?.Errors);
    }
    for (const r of failed) {
      buckets.rejected++;
      pushErrors(r, r.Errors ?? r.FederalReturn?.Errors);
    }

    if (buckets.processing > 0) return { status: 'Processing', errors: [], raw };
    const status: IrisAckStatus =
      buckets.accepted + buckets.awe === 0
        ? 'Rejected'
        : buckets.rejected + buckets.awe > 0
          ? 'AcceptedWithErrors'
          : 'Accepted';
    return { status, errors, raw };
  }

  /**
   * Submit a recipient for IRS TIN matching (async batch). Returns the SubmissionId
   * + RecordId to poll for the verdict later. `Business` is omitted so the request
   * links to the account's default business.
   */
  async submitTinMatch(recipient: TinMatchRecipientInput): Promise<TinMatchSubmitResult> {
    const res = await this.call(this.endpoints.tinMatchUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        TINMatchingDetails: {
          Recipients: [
            { SequenceId: recipient.sequenceId, Name: recipient.name, TINType: recipient.tinType, TIN: recipient.tin, IsForeign: false },
          ],
        },
      }),
    });
    const raw = await res.text();
    if (!res.ok) throw new AppError(ErrorCodes.E_IRIS, `TaxBandits TIN match submit failed (${res.status})`, 502, { raw });
    const body = JSON.parse(raw) as {
      SubmissionId?: string;
      TINMatchingRecords?: { SuccessRecords?: Array<{ RecordId?: string; Status?: string }> };
    };
    const rec = body.TINMatchingRecords?.SuccessRecords?.[0];
    return {
      submissionId: body.SubmissionId ?? '',
      recordId: rec?.RecordId ?? '',
      status: normalizeTinMatchStatus(rec?.Status ?? 'Order Created'),
      raw,
    };
  }

  /** Poll TIN-match verdicts for a submission. */
  async getTinMatchStatus(submissionId: string): Promise<TinMatchStatusResult[]> {
    const res = await this.call(`${this.endpoints.tinMatchStatusUrl}?SubmissionId=${encodeURIComponent(submissionId)}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    const raw = await res.text();
    if (!res.ok) throw new AppError(ErrorCodes.E_IRIS, `TaxBandits TIN match status failed (${res.status})`, 502, { raw });
    const body = JSON.parse(raw) as {
      Records?: Array<{ RecordId?: string; RecipientId?: string; SequenceId?: string; Status?: string }>;
      RecordId?: string;
      RecipientId?: string;
      SequenceId?: string;
      Status?: string;
    };
    const records = body.Records ?? [{ RecordId: body.RecordId, RecipientId: body.RecipientId, SequenceId: body.SequenceId, Status: body.Status }];
    return records.map((r) => ({
      recordId: r.RecordId ?? '',
      recipientRef: r.SequenceId ?? r.RecipientId ?? '',
      status: normalizeTinMatchStatus(r.Status ?? ''),
      rawStatus: r.Status ?? '',
    }));
  }

  /** Current prepaid-credit balance (integer cents). */
  async credits(): Promise<CreditBalance> {
    const res = await this.call(this.endpoints.creditsUrl, { method: 'GET', headers: { accept: 'application/json' } });
    const raw = await res.text();
    if (!res.ok) throw new AppError(ErrorCodes.E_IRIS, `TaxBandits credits failed (${res.status})`, 502, { raw });
    const body = JSON.parse(raw) as { AvailableCredits?: number; balanceCents?: number };
    // API reports dollars; store cents. Fall back to a cents field if the mock provides one.
    const cents = body.balanceCents ?? Math.round((body.AvailableCredits ?? 0) * 100);
    return { balanceCents: cents, raw };
  }
}
