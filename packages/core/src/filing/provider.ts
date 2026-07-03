/**
 * Filing-provider abstraction (Tax1099 Phase 1).
 *
 * The app can e-file 1099s two ways:
 *  - 'iris'    — the firm is the IRS Transmitter (needs its own TCC + JWK).
 *  - 'tax1099' — Tax1099 (Zenwork) is the transmitter and files on the payer's
 *                behalf, so the firm/entity needs NO IRS TCC. Requires only a
 *                Tax1099 API app key. Sends payee TINs off-appliance to Zenwork
 *                (a §7216 third-party disclosure) — hence explicit opt-in.
 *
 * Both providers reduce to the same two operations the worker drives: submit a
 * prepared payload, then poll for a terminal acknowledgement. Provider selection
 * is per-firm (default) and overridable per-payer; it is recorded on each
 * transmission row so the worker knows which backend to talk to.
 */
import type { IrisAckStatus, RecordError } from '../iris/client.js';

export type FilingProviderKind = 'iris' | 'tax1099';

export interface FilingTransmitResult {
  /** Provider's submission handle — IRIS Receipt ID or Tax1099 submission id. */
  providerRef: string;
  raw: string;
}

export interface FilingStatusResult {
  status: IrisAckStatus; // shared normalized ack vocabulary
  errors: RecordError[];
  raw: string;
}

export interface FilingProvider {
  readonly kind: FilingProviderKind;
  transmit(payload: string): Promise<FilingTransmitResult>;
  status(providerRef: string): Promise<FilingStatusResult>;
}
