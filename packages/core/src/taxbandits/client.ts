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
import { TaxBanditsAuth, type TaxBanditsCredentials } from './auth.js';

export interface TaxBanditsEndpoints {
  base: string;
  tokenUrl: string;
  efileUrl: string;
  statusUrl: string;
  correctionUrl: string;
  tinMatchUrl: string;
  creditsUrl: string;
}

export function taxbanditsEndpoints(base: string): TaxBanditsEndpoints {
  const b = base.replace(/\/$/, '');
  return {
    base: b,
    tokenUrl: `${b}/v1.7.3/oauth/tokens`,
    efileUrl: `${b}/v1.7.3/form1099/create`,
    statusUrl: `${b}/v1.7.3/form1099/status`,
    correctionUrl: `${b}/v1.7.3/form1099/correction`,
    tinMatchUrl: `${b}/v1.7.3/tinmatching/request`,
    creditsUrl: `${b}/v1.7.3/account/prepaidcredits`,
  };
}

export interface TbTinMatchResult {
  match: boolean;
  code: string;
  message: string;
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

  async transmit(payloadJson: string): Promise<FilingTransmitResult> {
    const res = await this.call(this.endpoints.efileUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payloadJson,
    });
    const raw = await res.text();
    if (!res.ok) throw new AppError(ErrorCodes.E_IRIS, `TaxBandits create rejected (${res.status})`, 502, { raw });
    return this.parseSubmission(raw);
  }

  /** Corrections/voids go through the correction endpoint but return the same ref shape. */
  async transmitCorrection(payloadJson: string): Promise<FilingTransmitResult> {
    const res = await this.call(this.endpoints.correctionUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payloadJson,
    });
    const raw = await res.text();
    if (!res.ok) throw new AppError(ErrorCodes.E_IRIS, `TaxBandits correction rejected (${res.status})`, 502, { raw });
    return this.parseSubmission(raw);
  }

  async status(submissionId: string): Promise<FilingStatusResult> {
    const res = await this.call(`${this.endpoints.statusUrl}?SubmissionId=${encodeURIComponent(submissionId)}`, {
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

  /** Real-time IRS TIN/name matching. */
  async tinMatch(tin: string, name: string, tinType: 'SSN' | 'EIN'): Promise<TbTinMatchResult> {
    const res = await this.call(this.endpoints.tinMatchUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ TIN: tin, Name: name, TINType: tinType }),
    });
    const raw = await res.text();
    if (!res.ok) throw new AppError(ErrorCodes.E_IRIS, `TaxBandits TIN match failed (${res.status})`, 502, { raw });
    const body = JSON.parse(raw) as { Match?: boolean; match?: boolean; Code?: string; Message?: string };
    const match = body.Match ?? body.match ?? false;
    return { match, code: body.Code ?? (match ? 'MATCH' : 'MISMATCH'), message: body.Message ?? '' };
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
