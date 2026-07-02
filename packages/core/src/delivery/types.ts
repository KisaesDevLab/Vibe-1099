/**
 * Delivery adapters (Phase 8) — provider-agnostic (LOCKED decision #8).
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailAdapter {
  readonly name: string;
  send(msg: EmailMessage): Promise<{ messageId: string }>;
  verify(): Promise<boolean>;
}

export interface SmsMessage {
  /** E.164 normalized before send */
  to: string;
  body: string;
}

export interface SmsAdapter {
  readonly name: string;
  send(msg: SmsMessage): Promise<{ messageId: string }>;
}

/** Normalize US numbers to E.164 (+1XXXXXXXXXX). Throws on non-US/invalid. */
export function toE164(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (/^\+1\d{10}$/.test(digits)) return digits;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  throw new Error(`Cannot normalize to E.164: ${raw}`);
}
