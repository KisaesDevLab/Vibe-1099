/**
 * Tax1099 (Zenwork) REST client — implements FilingProvider (submit + status)
 * plus Phase 2 add-ons (real-time TIN match, USPS recipient mailing, W-9
 * request). App-key auth. Base URL is env-selected (mock | sandbox | prod).
 *
 * Endpoint paths + the exact response envelope are finalized against the
 * Developer Hub contract; they are centralized here and in ./payload.ts so the
 * live wire-up is a localized change. The mock server mirrors these shapes.
 */
import { AppError, ErrorCodes } from '@vibe1099/shared';
import type { RecordError, IrisAckStatus } from '../iris/client.js';
import type { FilingProvider, FilingStatusResult, FilingTransmitResult } from '../filing/provider.js';

export interface Tax1099Endpoints {
  base: string;
  efileUrl: string;
  statusUrl: string;
  tinMatchUrl: string;
  mailUrl: string;
  w9Url: string;
}

export function tax1099Endpoints(base: string): Tax1099Endpoints {
  const b = base.replace(/\/$/, '');
  return {
    base: b,
    efileUrl: `${b}/api/v2/efile`,
    statusUrl: `${b}/api/v2/efile/status`,
    tinMatchUrl: `${b}/api/v2/tinmatch`,
    mailUrl: `${b}/api/v2/mail`,
    w9Url: `${b}/api/v2/w9/request`,
  };
}

export interface Tax1099Credentials {
  apiKey: string;
}

export interface TinMatchResult {
  match: boolean;
  code: string; // provider match code (e.g. TIN/name match/mismatch)
  message: string;
}

function normalizeStatus(s: string): IrisAckStatus {
  const t = s.trim().toLowerCase();
  if (t === 'accepted') return 'Accepted';
  if (/accepted.*error/.test(t)) return 'AcceptedWithErrors';
  if (t === 'rejected') return 'Rejected';
  if (t === 'notfound' || t === 'not found') return 'NotFound';
  return 'Processing';
}

export class Tax1099Client implements FilingProvider {
  readonly kind = 'tax1099' as const;

  constructor(
    private readonly endpoints: Tax1099Endpoints,
    private readonly creds: Tax1099Credentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          // Tax1099 app-key auth
          Authorization: this.creds.apiKey,
          'x-api-key': this.creds.apiKey,
        },
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new AppError(ErrorCodes.E_IRIS, `Tax1099 request failed: ${(err as Error).message}`, 502);
    }
  }

  async transmit(payloadJson: string): Promise<FilingTransmitResult> {
    const res = await this.call(this.endpoints.efileUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payloadJson,
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new AppError(ErrorCodes.E_IRIS, `Tax1099 eFile rejected (${res.status}): ${raw.slice(0, 1000)}`, 502, { raw });
    }
    let body: { submissionId?: string };
    try {
      body = JSON.parse(raw) as { submissionId?: string };
    } catch {
      throw new AppError(ErrorCodes.E_IRIS, 'Tax1099 eFile response was not JSON', 502, { raw });
    }
    if (!body.submissionId) {
      throw new AppError(ErrorCodes.E_IRIS, 'Tax1099 eFile response missing submissionId', 502, { raw });
    }
    return { providerRef: body.submissionId, raw };
  }

  async status(submissionId: string): Promise<FilingStatusResult> {
    const res = await this.call(`${this.endpoints.statusUrl}?submissionId=${encodeURIComponent(submissionId)}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    const raw = await res.text();
    if (res.status === 404) return { status: 'NotFound', errors: [], raw };
    if (!res.ok) {
      throw new AppError(ErrorCodes.E_IRIS, `Tax1099 status failed (${res.status}): ${raw.slice(0, 1000)}`, 502, { raw });
    }
    const body = JSON.parse(raw) as {
      status?: string;
      forms?: Array<{ refId?: string; status?: string; errors?: Array<{ code?: string; message?: string }> }>;
    };
    const errors: RecordError[] = [];
    for (const f of body.forms ?? []) {
      for (const e of f.errors ?? []) {
        errors.push({ recordId: f.refId ?? '', code: e.code ?? 'UNKNOWN', message: e.message ?? '' });
      }
    }
    return { status: normalizeStatus(body.status ?? 'Processing'), errors, raw };
  }

  // --- Phase 2 add-ons -------------------------------------------------------

  /** Real-time IRS TIN/name matching. */
  async tinMatch(tin: string, name: string, tinType: 'SSN' | 'EIN'): Promise<TinMatchResult> {
    const res = await this.call(this.endpoints.tinMatchUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tin, name, tinType }),
    });
    const raw = await res.text();
    if (!res.ok) throw new AppError(ErrorCodes.E_IRIS, `Tax1099 TIN match failed (${res.status})`, 502, { raw });
    const body = JSON.parse(raw) as { match?: boolean; code?: string; message?: string };
    return { match: !!body.match, code: body.code ?? '', message: body.message ?? '' };
  }

  /** Queue a USPS mailing of recipient copies for one submission (or subset). */
  async mailRecipients(submissionId: string, refIds?: string[]): Promise<{ mailId: string }> {
    const res = await this.call(this.endpoints.mailUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ submissionId, refIds: refIds ?? null }),
    });
    const raw = await res.text();
    if (!res.ok) throw new AppError(ErrorCodes.E_IRIS, `Tax1099 mailing failed (${res.status})`, 502, { raw });
    const body = JSON.parse(raw) as { mailId?: string };
    return { mailId: body.mailId ?? '' };
  }

  /** Send a W-9 collection request through Tax1099. */
  async requestW9(input: { name: string; email?: string | null; mobile?: string | null }): Promise<{ requestId: string }> {
    const res = await this.call(this.endpoints.w9Url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const raw = await res.text();
    if (!res.ok) throw new AppError(ErrorCodes.E_IRIS, `Tax1099 W-9 request failed (${res.status})`, 502, { raw });
    const body = JSON.parse(raw) as { requestId?: string };
    return { requestId: body.requestId ?? '' };
  }
}
