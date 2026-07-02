/**
 * IRIS A2A HTTP client — intake (transmit) + status retrieval, with
 * retry/backoff and a circuit breaker on endpoint failures (Phase 9).
 */
import { AppError, ErrorCodes } from '@vibe1099/shared';
import { getAccessToken, type IrisCredentials } from './auth.js';

export interface IrisEndpoints {
  base: string; // env-selected (ATS | PROD | mock)
  tokenUrl: string;
  intakeUrl: string;
  statusUrl: string; // + ?receiptId= / ?utid=
}

export function irisEndpoints(base: string): IrisEndpoints {
  const b = base.replace(/\/$/, '');
  return {
    base: b,
    tokenUrl: `${b}/auth/oauth/v2/token`,
    intakeUrl: `${b}/a2a/1099/transmissions`,
    statusUrl: `${b}/a2a/1099/transmissions/status`,
  };
}

export interface TransmitResult {
  receiptId: string;
  raw: string;
}

export type IrisAckStatus = 'Processing' | 'Accepted' | 'AcceptedWithErrors' | 'Rejected' | 'NotFound';

export interface RecordError {
  recordId: string;
  code: string;
  message: string;
}

export interface StatusResult {
  status: IrisAckStatus;
  errors: RecordError[];
  raw: string;
}

// --- circuit breaker ---------------------------------------------------------

interface BreakerState {
  failures: number;
  openedAt: number | null;
}
const breakers = new Map<string, BreakerState>();
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 5 * 60_000;

function breakerFor(base: string): BreakerState {
  let b = breakers.get(base);
  if (!b) {
    b = { failures: 0, openedAt: null };
    breakers.set(base, b);
  }
  return b;
}

function assertBreakerClosed(base: string): void {
  const b = breakerFor(base);
  if (b.openedAt && Date.now() - b.openedAt < BREAKER_COOLDOWN_MS) {
    throw new AppError(ErrorCodes.E_IRIS, 'IRIS endpoint circuit breaker open — retrying after cooldown', 503);
  }
  if (b.openedAt) {
    // half-open: allow one probe
    b.openedAt = null;
    b.failures = BREAKER_THRESHOLD - 1;
  }
}

function recordOutcome(base: string, ok: boolean): void {
  const b = breakerFor(base);
  if (ok) {
    b.failures = 0;
    b.openedAt = null;
  } else {
    b.failures += 1;
    if (b.failures >= BREAKER_THRESHOLD) b.openedAt = Date.now();
  }
}

export function resetBreakers(): void {
  breakers.clear();
}

// --- xml value extraction (minimal, namespace-agnostic) -----------------------

export function extractXmlValue(xml: string, element: string): string | null {
  const re = new RegExp(`<(?:\\w+:)?${element}[^>]*>([^<]*)</(?:\\w+:)?${element}>`);
  const m = xml.match(re);
  return m?.[1] ?? null;
}

export function extractAll(xml: string, element: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${element}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${element}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1] ?? '');
  return out;
}

// --- client -------------------------------------------------------------------

export class IrisClient {
  constructor(
    private readonly endpoints: IrisEndpoints,
    private readonly creds: IrisCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async authedFetch(url: string, init: RequestInit): Promise<Response> {
    assertBreakerClosed(this.endpoints.base);
    let token: string;
    try {
      token = await getAccessToken({ ...this.creds, tokenUrl: this.endpoints.tokenUrl }, this.fetchImpl);
    } catch (err) {
      recordOutcome(this.endpoints.base, false);
      throw new AppError(ErrorCodes.E_IRIS_AUTH, `IRIS auth failed: ${(err as Error).message}`, 502);
    }
    try {
      const res = await this.fetchImpl(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(120_000),
      });
      recordOutcome(this.endpoints.base, res.status < 500);
      return res;
    } catch (err) {
      recordOutcome(this.endpoints.base, false);
      throw new AppError(ErrorCodes.E_IRIS, `IRIS request failed: ${(err as Error).message}`, 502);
    }
  }

  async transmit(xml: string): Promise<TransmitResult> {
    const res = await this.authedFetch(this.endpoints.intakeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body: xml,
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new AppError(ErrorCodes.E_IRIS, `IRIS intake rejected (${res.status}): ${raw.slice(0, 1000)}`, 502, { raw });
    }
    const receiptId = extractXmlValue(raw, 'ReceiptId');
    if (!receiptId) {
      throw new AppError(ErrorCodes.E_IRIS, 'IRIS intake response missing ReceiptId', 502, { raw });
    }
    return { receiptId, raw };
  }

  async status(receiptId: string): Promise<StatusResult> {
    const res = await this.authedFetch(`${this.endpoints.statusUrl}?receiptId=${encodeURIComponent(receiptId)}`, {
      method: 'GET',
      headers: { accept: 'application/xml' },
    });
    const raw = await res.text();
    if (res.status === 404) return { status: 'NotFound', errors: [], raw };
    if (!res.ok) {
      throw new AppError(ErrorCodes.E_IRIS, `IRIS status failed (${res.status}): ${raw.slice(0, 1000)}`, 502, { raw });
    }
    const statusText = extractXmlValue(raw, 'TransmissionStatusCd') ?? extractXmlValue(raw, 'StatusCd') ?? 'Processing';
    const normalized: IrisAckStatus =
      statusText === 'A' || /^accepted$/i.test(statusText)
        ? 'Accepted'
        : statusText === 'E' || /accepted.?with.?errors/i.test(statusText)
          ? 'AcceptedWithErrors'
          : statusText === 'R' || /^rejected$/i.test(statusText)
            ? 'Rejected'
            : 'Processing';

    const errors: RecordError[] = [];
    for (const block of extractAll(raw, 'ErrorDetailGrp')) {
      errors.push({
        recordId: extractXmlValue(block, 'RecordId') ?? '',
        code: extractXmlValue(block, 'ErrorMessageCd') ?? extractXmlValue(block, 'ErrorCd') ?? 'UNKNOWN',
        message: extractXmlValue(block, 'ErrorMessageTxt') ?? '',
      });
    }
    return { status: normalized, errors, raw };
  }
}
