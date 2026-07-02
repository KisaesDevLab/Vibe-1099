/**
 * SMS adapters — TextLink and Twilio drivers (LOCKED decision #8).
 * Opt-out (STOP) is honored at the send layer via recipients.sms_opt_out;
 * inbound STOP handling is provider-webhook driven (docs/sms-opt-out.md).
 */
import type { SmsAdapter, SmsMessage } from './types.js';

export class TextLinkSmsAdapter implements SmsAdapter {
  readonly name = 'textlink';
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://textlinksms.com/api',
  ) {}

  async send(msg: SmsMessage): Promise<{ messageId: string }> {
    const res = await fetch(`${this.baseUrl}/send-sms`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ phone_number: msg.to, text: msg.body }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`TextLink send failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { messageId: String(body['message_id'] ?? body['id'] ?? '') };
  }
}

export class TwilioSmsAdapter implements SmsAdapter {
  readonly name = 'twilio';
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fromNumber: string,
    private readonly baseUrl = 'https://api.twilio.com',
  ) {}

  async send(msg: SmsMessage): Promise<{ messageId: string }> {
    const url = `${this.baseUrl}/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const params = new URLSearchParams({ To: msg.to, From: this.fromNumber, Body: msg.body });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
      },
      body: params.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Twilio send failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const body = (await res.json()) as { sid: string };
    return { messageId: body.sid };
  }
}

export class NullSmsAdapter implements SmsAdapter {
  readonly name = 'null';
  sent: SmsMessage[] = [];
  async send(msg: SmsMessage): Promise<{ messageId: string }> {
    this.sent.push(msg);
    return { messageId: `null-${this.sent.length}` };
  }
}
