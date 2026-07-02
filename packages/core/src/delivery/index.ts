export * from './types.js';
export * from './email-smtp.js';
export * from './sms.js';
export * from './templates.js';

import { loadEnv } from '../env.js';
import type { EmailAdapter, SmsAdapter } from './types.js';
import { NullEmailAdapter, SmtpEmailAdapter } from './email-smtp.js';
import { NullSmsAdapter, TextLinkSmsAdapter, TwilioSmsAdapter } from './sms.js';

let email: EmailAdapter | undefined;
let sms: SmsAdapter | undefined;

/** Env-configured adapters; firm-level overrides resolved at call sites. */
export function getEmailAdapter(): EmailAdapter {
  if (!email) {
    const env = loadEnv();
    email = env.SMTP_HOST
      ? new SmtpEmailAdapter({
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          user: env.SMTP_USER,
          pass: env.SMTP_PASS,
          from: env.SMTP_FROM,
          secure: env.SMTP_SECURE === 1,
        })
      : new NullEmailAdapter();
  }
  return email;
}

export function getSmsAdapter(): SmsAdapter {
  if (!sms) {
    const env = loadEnv();
    if (env.SMS_PROVIDER === 'textlink' && env.TEXTLINK_API_KEY) {
      sms = new TextLinkSmsAdapter(env.TEXTLINK_API_KEY);
    } else if (env.SMS_PROVIDER === 'twilio' && env.TWILIO_ACCOUNT_SID) {
      sms = new TwilioSmsAdapter(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.TWILIO_FROM_NUMBER);
    } else {
      sms = new NullSmsAdapter();
    }
  }
  return sms;
}

export function setAdaptersForTest(e: EmailAdapter, s: SmsAdapter): void {
  email = e;
  sms = s;
}
