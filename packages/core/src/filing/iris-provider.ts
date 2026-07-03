/**
 * IRIS implementation of FilingProvider — thin wrapper over IrisClient so the
 * existing A2A path plugs into the provider-neutral worker flow unchanged.
 */
import { IrisClient } from '../iris/client.js';
import type { FilingProvider, FilingStatusResult, FilingTransmitResult } from './provider.js';

export class IrisFilingProvider implements FilingProvider {
  readonly kind = 'iris' as const;
  constructor(private readonly client: IrisClient) {}

  async transmit(xml: string): Promise<FilingTransmitResult> {
    const r = await this.client.transmit(xml);
    return { providerRef: r.receiptId, raw: r.raw };
  }

  status(providerRef: string): Promise<FilingStatusResult> {
    return this.client.status(providerRef);
  }
}
