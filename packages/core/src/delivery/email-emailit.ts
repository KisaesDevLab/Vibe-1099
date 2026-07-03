/**
 * EmailIt.com email adapter (API v2). REST + JSON, Bearer-auth.
 *   POST https://api.emailit.com/v2/emails
 *   Authorization: Bearer <api key>
 *   { from, to, subject, html, text, reply_to } -> { message_id, id, status }
 * Docs: https://emailit.com/docs/api-reference/
 */
import type { EmailAdapter, EmailMessage } from './types.js';

export interface EmailItConfig {
  apiKey: string;
  from: string;
  replyTo?: string;
  baseUrl?: string;
}

export class EmailItEmailAdapter implements EmailAdapter {
  readonly name = 'emailit';
  private readonly baseUrl: string;

  constructor(private readonly config: EmailItConfig) {
    this.baseUrl = (config.baseUrl ?? 'https://api.emailit.com').replace(/\/$/, '');
  }

  async send(msg: EmailMessage): Promise<{ messageId: string }> {
    const res = await fetch(`${this.baseUrl}/v2/emails`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        from: this.config.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        // EmailIt requires html OR text; fall back to text wrapped so html-less sends still work
        html: msg.html ?? undefined,
        ...(this.config.replyTo ? { reply_to: this.config.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`EmailIt send failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { messageId: String(body['id'] ?? body['message_id'] ?? '') };
  }

  async verify(): Promise<boolean> {
    // no cheap health endpoint; treat a present key as configured
    return !!this.config.apiKey;
  }
}
