/**
 * Filing-provider abstraction (Tax1099 Phase 1).
 *
 * The app can e-file 1099s two ways:
 *  - 'iris'    — the firm is the IRS Transmitter (needs its own TCC + JWK).
 *  - 'tax1099' — Tax1099 (Zenwork) is the transmitter and files on the payer's
 *                behalf, so the firm/entity needs NO IRS TCC. Requires only a
 *                Tax1099 API app key. Sends payee TINs off-appliance to Zenwork
 *                (a §7216 third-party disclosure) — hence explicit opt-in.
 *  - 'taxbandits' — TaxBandits (SPAN Enterprises) is the transmitter under their
 *                TCC. Used as a contingency while a firm's own IRS TCC is pending,
 *                and for TIN matching / broader state direct-file. Prepaid-credit
 *                billing. Also a §7216 third-party disclosure — explicit opt-in.
 *
 * All providers reduce to the same two operations the worker drives: submit a
 * prepared payload, then poll for a terminal acknowledgement. Provider selection
 * is per-firm (default) and overridable per-payer; it is recorded on each
 * transmission row so the worker knows which backend to talk to. Corrections MUST
 * transmit through the same provider as the original (affinity invariant).
 */
import type { IrisAckStatus, RecordError } from '../iris/client.js';

export type FilingProviderKind = 'iris' | 'tax1099' | 'taxbandits';

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
  /** opts.formType routes providers whose status endpoints are per form type
   *  (TaxBandits); IRIS/Tax1099 ignore it. */
  status(providerRef: string, opts?: { formType?: string }): Promise<FilingStatusResult>;
}
