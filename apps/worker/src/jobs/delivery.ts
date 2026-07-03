/**
 * Delivery worker (Phase 8): email/SMS sends via configured adapters, delivery
 * tracking (sent/bounced), template resolution with settings overrides.
 */
import { eq } from 'drizzle-orm';
import { Job } from 'bullmq';
import { eq as eqOp } from 'drizzle-orm';
import {
  createLogger,
  DEFAULT_TEMPLATES,
  EmailItEmailAdapter,
  getCrypto,
  getEmailAdapter,
  getSmsAdapter,
  renderTemplate,
  SmtpEmailAdapter,
  TextLinkSmsAdapter,
  toE164,
  TwilioSmsAdapter,
  type DeliveryJob,
  type EmailAdapter,
  type MessageTemplate,
  type SmsAdapter,
} from '@vibe1099/core';
import { appSettings, deliveries, firms, getDb } from '@vibe1099/db';

const log = createLogger('worker:delivery');

/**
 * Per-firm SMS adapter resolution: Settings-configured override (secrets
 * envelope-encrypted in firms.sms_override) wins; env-configured adapter is
 * the fallback.
 */
async function resolveSmsAdapter(firmId: string): Promise<SmsAdapter> {
  const firm = await getDb().query.firms.findFirst({ where: eqOp(firms.id, firmId) });
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

/**
 * Per-firm email adapter resolution: Settings-configured override (secrets
 * envelope-encrypted in firms.smtp_override) wins; env-configured adapter is
 * the fallback. Supports EmailIt (API) and SMTP.
 */
async function resolveEmailAdapter(firmId: string): Promise<EmailAdapter> {
  const firm = await getDb().query.firms.findFirst({ where: eqOp(firms.id, firmId) });
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

async function resolveTemplate(key: string): Promise<MessageTemplate> {
  const db = getDb();
  const row = await db.query.appSettings.findFirst({ where: eq(appSettings.key, 'message_templates') });
  const custom = (row?.value as MessageTemplate[] | null)?.find((t) => t.key === key);
  const fallback = DEFAULT_TEMPLATES.find((t) => t.key === key);
  const template = custom ?? fallback;
  if (!template) throw new Error(`unknown template: ${key}`);
  return template;
}

export async function handleDeliveryJob(job: Job): Promise<void> {
  const data = job.data as DeliveryJob;
  const db = getDb();
  const template = await resolveTemplate(data.templateKey);
  const body = renderTemplate(template.body, data.vars);

  try {
    if (data.channel === 'email') {
      const subject = renderTemplate(template.subject, data.vars);
      const emailer = await resolveEmailAdapter(data.firmId);
      await emailer.send({ to: data.to, subject, text: body });
    } else {
      const sms = await resolveSmsAdapter(data.firmId);
      await sms.send({ to: toE164(data.to), body });
    }
    if (data.deliveryId) {
      await db.update(deliveries).set({ sentAt: new Date() }).where(eq(deliveries.id, data.deliveryId));
    }
    log.info({ kind: data.kind, channel: data.channel }, 'delivered');
  } catch (err) {
    // terminal failure after BullMQ retries exhausts → mark bounced
    if (data.deliveryId && job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
      await db
        .update(deliveries)
        .set({ bouncedAt: new Date(), failReason: (err as Error).message.slice(0, 500) })
        .where(eq(deliveries.id, data.deliveryId));
    }
    throw err;
  }
}
