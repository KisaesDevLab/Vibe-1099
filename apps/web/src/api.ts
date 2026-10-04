/**
 * API client — CSRF double-submit header on mutations; uniform error surface.
 */

export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** The v1099_csrf double-submit token (readable cookie); also handed to the Vibe Auth settings page. */
export function csrfToken(): string {
  return document.cookie.match(/(?:^|;\s*)v1099_csrf=([^;]+)/)?.[1] ?? '';
}

async function request<T>(method: string, path: string, body?: unknown, opts?: { token?: string }): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(method)) headers['x-csrf-token'] = csrfToken();
  if (opts?.token) headers['authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    if (contentType.includes('application/json')) {
      const payload = (await res.json()) as { error?: { code: string; message: string; details?: unknown } };
      throw new ApiError(payload.error?.code ?? 'E_UNKNOWN', payload.error?.message ?? res.statusText, res.status, payload.error?.details);
    }
    throw new ApiError('E_UNKNOWN', res.statusText, res.status);
  }
  if (contentType.includes('application/json')) return (await res.json()) as T;
  return (await res.blob()) as unknown as T;
}

export const api = {
  get: <T>(path: string, opts?: { token?: string }) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: { token?: string }) => request<T>('POST', path, body, opts),
  put: <T>(path: string, body?: unknown, opts?: { token?: string }) => request<T>('PUT', path, body, opts),
  patch: <T>(path: string, body?: unknown, opts?: { token?: string }) => request<T>('PATCH', path, body, opts),
  del: <T>(path: string, opts?: { token?: string }) => request<T>('DELETE', path, undefined, opts),
};

export function formatCents(cents: number | null | undefined): string {
  if (cents == null) return '';
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? '-' : ''}${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

export function parseCentsInput(input: string): number {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (cleaned === '') return 0;
  if (!/^\d*(\.\d{0,2})?$/.test(cleaned)) throw new Error(`Invalid amount: ${input}`);
  const [whole = '0', frac = ''] = cleaned.split('.');
  return parseInt(whole || '0', 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
}

/** Form types the registry serves (mirrors packages/shared FORM_TYPES — the SPA cannot import it). */
export const FORM_TYPES = ['NEC', 'MISC', 'INT', 'DIV', '1098'] as const;

/** Printed form number: 1099-NEC … but Form 1098 is not a 1099. */
export function formTypeLabel(formType: string): string {
  return formType === '1098' ? 'Form 1098' : `1099-${formType}`;
}

/** Split one CSV line per RFC 4180: quoted fields may hold commas and doubled quotes (Excel exports). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** Header-keyed rows from pasted/uploaded CSV text (BOM tolerated, blank lines skipped). */
export function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.replace(/^﻿/, '').trim().split(/\r?\n/);
  const headers = splitCsvLine(lines[0] ?? '');
  return lines
    .slice(1)
    .filter((l) => l.trim() !== '')
    .map((line) => {
      const cells = splitCsvLine(line);
      return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']));
    });
}

/**
 * Filename for a PDF downloaded for a payer: PayersName-Year-FormType-ClientID.pdf.
 * Name/ID are reduced to filename-safe characters (same rule as the archive ZIP's
 * per-payer files); a payer with no client ID gets "NoID". `suffix` tells apart
 * variants of the same payer/year/form (e.g. the Z-fold vs client-copy layout).
 */
export function payerPdfName(payerName: string, taxYear: number, formType: string, clientId: string | null | undefined, suffix = ''): string {
  const name = payerName.replace(/[^A-Za-z0-9]+/g, '') || 'Payer';
  const id = (clientId ?? '').replace(/[^A-Za-z0-9-]+/g, '') || 'NoID';
  return `${name}-${taxYear}-${formType}-${id}${suffix ? `-${suffix}` : ''}.pdf`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
