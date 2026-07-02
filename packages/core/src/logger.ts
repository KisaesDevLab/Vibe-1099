/**
 * Structured logging (pino) with PII redaction (Phase 1).
 * Rule: never log TINs; box values at debug only.
 */
import { pino, type Logger } from 'pino';

const TIN_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN dashed
  /\b\d{2}-\d{7}\b/g, // EIN dashed
  /\b\d{3}\s\d{2}\s\d{4}\b/g, // SSN spaced
  /\b\d{9}\b/g, // 9 raw digits
];

export function redactPii(value: string): string {
  let out = value;
  for (const re of TIN_PATTERNS) out = out.replace(re, '[TIN-REDACTED]');
  return out;
}

/**
 * Recursively scrub TIN-shaped strings out of any log argument (objects, arrays,
 * Error messages/stacks). Pino's common shape is log.x({obj}, 'msg'); the merge
 * object and nested Error payloads must be scrubbed, not just top-level strings.
 * Bounded depth to avoid pathological structures.
 */
function scrubDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === 'string') return redactPii(value);
  if (value instanceof Error) {
    const e: Record<string, unknown> = { name: value.name, message: redactPii(value.message) };
    if (value.stack) e['stack'] = redactPii(value.stack);
    for (const k of Object.keys(value)) e[k] = scrubDeep((value as unknown as Record<string, unknown>)[k], depth + 1);
    return e;
  }
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubDeep(v, depth + 1);
    return out;
  }
  return value;
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
        // deep-scrub TIN-shaped values from every arg — free-text messages AND
        // merge objects / Error payloads (the key/path allowlist above only
        // covers known keys at fixed depths; this is the catch-all net)
        const scrubbed = args.map((a) => scrubDeep(a)) as Parameters<typeof method>;
        method.apply(this, scrubbed);
      },
    },
  });
}
