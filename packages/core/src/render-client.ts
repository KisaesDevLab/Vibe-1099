/**
 * HTTP client for the WeasyPrint render sidecar.
 * POST /render { template, data, css? } -> PDF bytes
 */
import { AppError, ErrorCodes } from '@vibe1099/shared';

export interface RenderRequest {
  template: string; // e.g. 'copy_b_nec.html', 'zfold_sheet.html'
  data: Record<string, unknown>;
}

export class RenderClient {
  constructor(private readonly baseUrl: string) {}

  async render(req: RenderRequest, timeoutMs = 60_000): Promise<Buffer> {
    const res = await fetch(`${this.baseUrl}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((err: Error) => {
      throw new AppError(ErrorCodes.E_RENDER, `Render sidecar unreachable: ${err.message}`, 502);
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AppError(ErrorCodes.E_RENDER, `Render failed (${res.status}): ${text.slice(0, 500)}`, 502);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /** Merge multiple rendered PDFs into one (sidecar endpoint). */
  async merge(pdfs: Buffer[], timeoutMs = 120_000): Promise<Buffer> {
    const res = await fetch(`${this.baseUrl}/merge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pdfs: pdfs.map((p) => p.toString('base64')) }),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((err: Error) => {
      throw new AppError(ErrorCodes.E_RENDER, `Render sidecar unreachable: ${err.message}`, 502);
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AppError(ErrorCodes.E_RENDER, `Merge failed (${res.status}): ${text.slice(0, 500)}`, 502);
    }
    const body = (await res.json()) as { pdf: string; pageCount: number };
    return Buffer.from(body.pdf, 'base64');
  }

  async mergeWithCount(pdfs: Buffer[], timeoutMs = 120_000): Promise<{ pdf: Buffer; pageCount: number }> {
    const res = await fetch(`${this.baseUrl}/merge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pdfs: pdfs.map((p) => p.toString('base64')) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AppError(ErrorCodes.E_RENDER, `Merge failed (${res.status}): ${text.slice(0, 500)}`, 502);
    }
    const body = (await res.json()) as { pdf: string; pageCount: number };
    return { pdf: Buffer.from(body.pdf, 'base64'), pageCount: body.pageCount };
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3_000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}

let client: RenderClient | undefined;
export function getRenderClient(baseUrl?: string): RenderClient {
  if (!client) client = new RenderClient(baseUrl ?? process.env.RENDER_URL ?? 'http://localhost:8212');
  return client;
}
