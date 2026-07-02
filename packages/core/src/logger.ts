/**
 * Structured logging (pino) with PII redaction (Phase 1).
 * Rule: never log TINs; box values at debug only.
 */
import { pino, type Logger } from 'pino';

const TIN_PATTERNS = [/\b\d{3}-\d{2}-\d{4}\b/g, /\b\d{2}-\d{7}\b/g, /\b\d{9}\b/g];

export function redactPii(value: string): string {
  let out = value;
  for (const re of TIN_PATTERNS) out = out.replace(re, '[TIN-REDACTED]');
  return out;
}

export function createLogger(name: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    name,
    level,
    redact: {
      paths: [
        'tin',
        '*.tin',
        '*.*.tin',
        'tinEncrypted',
        '*.tinEncrypted',
        'password',
        '*.password',
        'passwordHash',
        '*.passwordHash',
        'boxValues',
        '*.boxValues',
        'req.headers.cookie',
        'req.headers.authorization',
      ],
      censor: '[REDACTED]',
    },
    hooks: {
      logMethod(args, method) {
        // scrub TIN-shaped strings out of free-text messages
        const scrubbed = args.map((a) => (typeof a === 'string' ? redactPii(a) : a)) as Parameters<typeof method>;
        method.apply(this, scrubbed);
      },
    },
  });
}
