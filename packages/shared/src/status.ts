/**
 * Form record status machine (LOCKED):
 * draft → ready → queued → transmitted → accepted | rejected → corrected(n)
 *
 * - rejected returns to draft for edit → requeue
 * - accepted records lock; changes go through the corrections path
 * - deletable only in draft/ready
 */

export const FORM_STATUSES = [
  'draft',
  'ready',
  'queued',
  'transmitted',
  'accepted',
  'accepted_with_errors',
  'rejected',
  'corrected',
] as const;

export type FormStatus = (typeof FORM_STATUSES)[number];

const TRANSITIONS: Record<FormStatus, FormStatus[]> = {
  draft: ['ready'],
  ready: ['draft', 'queued'],
  queued: ['transmitted', 'ready'], // ready = de-queue before transmit
  transmitted: ['accepted', 'accepted_with_errors', 'rejected'],
  accepted: ['corrected'],
  accepted_with_errors: ['corrected'],
  rejected: ['draft'], // edit and requeue
  corrected: [], // terminal for that version; corrections spawn new records
};

export function canTransition(from: FormStatus, to: FormStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: FormStatus, to: FormStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid status transition: ${from} → ${to}`);
  }
}

export function isDeletable(status: FormStatus): boolean {
  return status === 'draft' || status === 'ready';
}

export function isEditable(status: FormStatus): boolean {
  return status === 'draft' || status === 'ready' || status === 'rejected';
}

export function isCorrectable(status: FormStatus): boolean {
  return status === 'accepted' || status === 'accepted_with_errors';
}
