/**
 * Message templates (Phase 8) — editable in Settings (app_settings key
 * 'message_templates'); these are the shipped defaults. Variables use
 * {{var}} placeholders. Links carry opaque tokens only — no TIN, no name.
 */

export interface MessageTemplate {
  key: string;
  channel: 'email' | 'sms' | 'both';
  subject: string; // email only
  body: string;
  vars: string[];
}

export const DEFAULT_TEMPLATES: MessageTemplate[] = [
  {
    key: 'form_available',
    channel: 'both',
    subject: 'Your {{taxYear}} tax form from {{payerName}} is available',
    body:
      'Your {{taxYear}} Form 1099-{{formType}} from {{payerName}} is ready. ' +
      'Your paper copy has been mailed; you may also view it securely here: {{link}} ' +
      '(link expires {{expires}}). You will be asked to verify the last 4 digits of your Taxpayer ID.',
    vars: ['taxYear', 'formType', 'payerName', 'link', 'expires'],
  },
  {
    key: 'form_corrected',
    channel: 'both',
    subject: 'CORRECTED {{taxYear}} tax form from {{payerName}}',
    body:
      'A CORRECTED {{taxYear}} Form 1099-{{formType}} from {{payerName}} has been issued. ' +
      'A corrected paper copy has been mailed; view it securely here: {{link}} (expires {{expires}}).',
    vars: ['taxYear', 'formType', 'payerName', 'link', 'expires'],
  },
  {
    key: 'w9_request',
    channel: 'both',
    subject: '{{firmName}} requests your Form W-9',
    body:
      '{{requesterName}} has requested that you complete a Form W-9 so your tax documents can be prepared. ' +
      'Complete it securely here: {{link}} (expires {{expires}}).',
    vars: ['firmName', 'requesterName', 'link', 'expires'],
  },
  {
    key: 'w9_reminder',
    channel: 'both',
    subject: 'Reminder: Form W-9 requested by {{firmName}}',
    body: 'Reminder — please complete your Form W-9: {{link}} (expires {{expires}}).',
    vars: ['firmName', 'link', 'expires'],
  },
  {
    key: 'client_invite',
    channel: 'both',
    subject: '{{firmName}} — enter your {{taxYear}} 1099 information',
    body:
      '{{firmName}} has invited you to provide {{taxYear}} 1099 information for {{payerName}}. ' +
      'Use this secure link: {{link}} (expires {{expires}}).',
    vars: ['firmName', 'payerName', 'taxYear', 'link', 'expires'],
  },
  {
    key: 'password_reset',
    channel: 'email',
    subject: 'Vibe 1099 password reset',
    body: 'A password reset was requested for your account. Reset here: {{link}} (expires in 1 hour). If you did not request this, ignore this message.',
    vars: ['link'],
  },
  {
    key: 'staff_alert',
    channel: 'email',
    subject: 'Vibe 1099 alert: {{subject}}',
    body: '{{message}}',
    vars: ['subject', 'message'],
  },
  {
    key: 'portal_code',
    channel: 'both',
    subject: 'Your verification code: {{code}}',
    body: 'Your one-time code to view your secure {{firmName}} portal is {{code}}. It expires in 10 minutes. If you did not request this, ignore this message.',
    vars: ['code', 'firmName'],
  },
];

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => vars[name] ?? '');
}
