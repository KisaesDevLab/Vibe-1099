/**
 * Per-firm delivery adapter resolution — the SINGLE implementation used by both
 * the worker (real sends) and the API (Settings → send test message). Keeping
 * one copy is the point: a test that resolved adapters differently from
 * production could pass while real delivery is broken.
 *
 * Precedence: the firm's Settings override (secrets envelope-encrypted in
 * firms.smtp_override / firms.sms_override) wins; the env-configured adapter is
 * the fallback; provider 'none' is an explicit opt-out and throws.
 */
import { eq } from 'drizzle-orm';
import { firms, type Db } from '@vibe1099/db';
import { getCrypto } from '../crypto.js';
import { getEmailAdapter, getSmsAdapter } from './index.js';
import { EmailItEmailAdapter } from './email-emailit.js';
import { SmtpEmailAdapter } from './email-smtp.js';
import { TextLinkSmsAdapter, TwilioSmsAdapter } from './sms.js';
import type { EmailAdapter, SmsAdapter } from './types.js';

export async function resolveSmsAdapter(db: Db, firmId: string): Promise<SmsAdapter> {
  const firm = await db.query.firms.findFirst({ where: eq(firms.id, firmId) });
  const o = (firm?.smsOverride ?? null) as Record<string, string> | null;
  if (o?.['provider'] === 'textlink' && o['textlinkApiKeyEncrypted']) {
    return new TextLinkSmsAdapter(getCrypto().decrypt(o['textlinkApiKeyEncrypted']));
  }
  if (o?.['provider'] === 'twilio' && o['twilioAuthTokenEncrypted']) {
    return new TwilioSmsAdapter(
      o['twilioAccountSid'] ?? '',
      getCrypto().decrypt(o['twilioAuthTokenEncrypted']),
      o['twilioFromNumber'] ?? '',
    );
  }
  if (o?.['provider'] === 'none') {
    throw new Error('SMS disabled for this firm (Settings → SMS provider)');
  }
  return getSmsAdapter();
}

export async function resolveEmailAdapter(db: Db, firmId: string): Promise<EmailAdapter> {
  const firm = await db.query.firms.findFirst({ where: eq(firms.id, firmId) });
  const o = (firm?.smtpOverride ?? null) as Record<string, string> | null;
  const crypto = getCrypto();
  if (o?.['provider'] === 'emailit' && o['emailitApiKeyEncrypted']) {
    return new EmailItEmailAdapter({
      apiKey: crypto.decrypt(o['emailitApiKeyEncrypted']),
      from: o['from'] ?? '',
      replyTo: o['replyTo'] || undefined,
    });
  }
  if (o?.['provider'] === 'smtp' && o['host']) {
    return new SmtpEmailAdapter({
      host: o['host'],
      port: Number(o['port'] ?? 587),
      user: o['user'] ?? '',
      pass: o['passEncrypted'] ? crypto.decrypt(o['passEncrypted']) : '',
      from: o['from'] ?? '',
      secure: o['secure'] === '1',
    });
  }
  if (o?.['provider'] === 'none') {
    throw new Error('Email disabled for this firm (Settings → Email provider)');
  }
  return getEmailAdapter();
}
