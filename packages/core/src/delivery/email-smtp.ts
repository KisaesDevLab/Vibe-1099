/**
 * SMTP email adapter (firm's relay). DKIM guidance: docs/dkim-smtp.md
 */
import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailAdapter, EmailMessage } from './types.js';

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  secure: boolean;
}

export class SmtpEmailAdapter implements EmailAdapter {
  readonly name = 'smtp';
  private transporter: Transporter;

  constructor(private readonly config: SmtpConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      // Require STARTTLS on non-implicit-TLS connections so portal-link emails
      // never fall back to a cleartext relay hop (FTC Safeguards — data in transit).
      requireTLS: !config.secure,
      auth: config.user ? { user: config.user, pass: config.pass } : undefined,
    });
  }

  async send(msg: EmailMessage): Promise<{ messageId: string }> {
    const info = await this.transporter.sendMail({
      from: this.config.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
    return { messageId: info.messageId ?? '' };
  }

  async verify(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch {
      return false;
    }
  }
}

/** No-op adapter used when SMTP is unconfigured (dev / pre-onboarding). */
export class NullEmailAdapter implements EmailAdapter {
  readonly name = 'null';
  /** last few messages only — these carry live portal links and must not pile up in memory */
  sent: EmailMessage[] = [];
  private counter = 0;
  async send(msg: EmailMessage): Promise<{ messageId: string }> {
    this.sent.push(msg);
    if (this.sent.length > 50) this.sent.splice(0, this.sent.length - 50);
    return { messageId: `null-${++this.counter}` };
  }
  async verify(): Promise<boolean> {
    return true;
  }
}

/**
 * Production stand-in for "nothing configured": every send FAILS loudly so the
 * delivery row is marked bounced and the Settings test reports the gap, instead
 * of invites, portal links, OTP codes and W-9 requests "succeeding" into a void.
 */
export class UnconfiguredEmailAdapter implements EmailAdapter {
  readonly name = 'none';
  async send(): Promise<{ messageId: string }> {
    throw new Error('No email provider is configured — Settings → Delivery (SMTP or EmailIt)');
  }
  async verify(): Promise<boolean> {
    return false;
  }
}
