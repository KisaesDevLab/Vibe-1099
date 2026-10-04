/**
 * Delivery worker (Phase 8): email/SMS sends via configured adapters, delivery
 * tracking (sent/bounced), template resolution with settings overrides.
 */
import { and, eq, sql } from 'drizzle-orm';
import { Job } from 'bullmq';
import {
  createLogger,
  DEFAULT_TEMPLATES,
  renderTemplate,
  resolveEmailAdapter,
  resolveSmsAdapter,
  toE164,
  type DeliveryJob,
  type MessageTemplate,
} from '@vibe1099/core';
import { appSettings, deliveries, getDb, recipients } from '@vibe1099/db';

const log = createLogger('worker:delivery');
// Adapter resolution lives in @vibe1099/core (delivery/resolve.ts) so the
// Settings "send test message" action exercises the exact same precedence as
// these real sends.

async function resolveTemplate(key: string): Promise<MessageTemplate> {
  const db = getDb();
  const row = await db.query.appSettings.findFirst({ where: eq(appSettings.key, 'message_templates') });
  const custom = (row?.value as MessageTemplate[] | null)?.find((t) => t.key === key);
  const fallback = DEFAULT_TEMPLATES.find((t) => t.key === key);
  const template = custom ?? fallback;
  if (!template) throw new Error(`unknown template: ${key}`);
  return template;
}

/** STOP is honored at the send layer: any recipient of this firm with that mobile number opted out. */
async function smsOptedOut(firmId: string, to: string): Promise<boolean> {
  const digits = to.replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
  if (digits.length !== 10) return false;
  const row = await getDb().query.recipients.findFirst({
    where: and(eq(recipients.firmId, firmId), eq(recipients.smsOptOut, true), sql`regexp_replace(coalesce(${recipients.mobile}, ''), '\\D', '', 'g') ~ ${`${digits}$`}`),
    columns: { id: true },
  });
  return !!row;
}

export async function handleDeliveryJob(job: Job): Promise<void> {
  const data = job.data as DeliveryJob;
  const db = getDb();
  if (data.scrubbed) {
    // a failed job whose secrets were removed — re-send it from the screen it came from
    throw new Error('This delivery failed earlier and its link was scrubbed — re-send it from the Deliveries / Invites / W-9 screen');
  }
  const template = await resolveTemplate(data.templateKey);
  const body = renderTemplate(template.body, data.vars);

  try {
    if (data.channel === 'email') {
      const subject = renderTemplate(template.subject, data.vars);
      const emailer = await resolveEmailAdapter(db, data.firmId);
      await emailer.send({ to: data.to, subject, text: body });
    } else {
      if (await smsOptedOut(data.firmId, data.to)) {
        log.info({ kind: data.kind }, 'SMS suppressed — recipient opted out (STOP)');
        if (data.deliveryId) {
          await db.update(deliveries).set({ bouncedAt: new Date(), failReason: 'sms_opt_out' }).where(eq(deliveries.id, data.deliveryId));
        }
        return;
      }
      const sms = await resolveSmsAdapter(db, data.firmId);
      await sms.send({ to: toE164(data.to), body });
    }
    if (data.deliveryId) {
      await db.update(deliveries).set({ sentAt: new Date() }).where(eq(deliveries.id, data.deliveryId));
    }
    log.info({ kind: data.kind, channel: data.channel }, 'delivered');
  } catch (err) {
    const terminal = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (terminal) {
      // terminal failure after BullMQ retries exhaust → mark bounced
      if (data.deliveryId) {
        await db
          .update(deliveries)
          .set({ bouncedAt: new Date(), failReason: (err as Error).message.slice(0, 500) })
          .where(eq(deliveries.id, data.deliveryId));
      }
      // keep the failed job visible (admin queue view) but without its live
      // magic link / reset token / OTP code
      await job.updateData({ ...data, vars: {}, scrubbed: true } satisfies DeliveryJob).catch(() => undefined);
      log.error({ kind: data.kind, channel: data.channel, err: (err as Error).message }, 'delivery failed permanently');
    }
    throw err;
  }
}
