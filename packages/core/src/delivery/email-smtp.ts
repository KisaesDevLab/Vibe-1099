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
  sent: EmailMessage[] = [];
  async send(msg: EmailMessage): Promise<{ messageId: string }> {
    this.sent.push(msg);
    return { messageId: `null-${this.sent.length}` };
  }
  async verify(): Promise<boolean> {
    return true;
  }
}
