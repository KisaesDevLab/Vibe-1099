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

function normalizeStatus(s: string): IrisAckStatus {
  const t = s.trim().toLowerCase();
  if (t === 'accepted' || t === 'transmitted') return 'Accepted';
  if (/accepted.*error/.test(t) || t === 'acceptedwitherrors') return 'AcceptedWithErrors';
  if (t === 'rejected') return 'Rejected';
  if (t === 'notfound' || t === 'not found') return 'NotFound';
  return 'Processing';
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
    let body: { SubmissionId?: string; submissionId?: string };
    try {
      body = JSON.parse(raw) as { SubmissionId?: string; submissionId?: string };
    } catch {
      throw new AppError(ErrorCodes.E_IRIS, 'TaxBandits response was not JSON', 502, { raw });
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
    const body = JSON.parse(raw) as {
      Status?: string;
      status?: string;
      Records?: Array<{ RecordId?: string; PayeeRef?: string; Status?: string; Errors?: Array<{ Code?: string; Message?: string }> }>;
    };
    const errors: RecordError[] = [];
    for (const r of body.Records ?? []) {
      for (const e of r.Errors ?? []) {
        errors.push({ recordId: r.PayeeRef ?? r.RecordId ?? '', code: e.Code ?? 'UNKNOWN', message: e.Message ?? '' });
      }
    }
    return { status: normalizeStatus(body.Status ?? body.status ?? 'Processing'), errors, raw };
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
