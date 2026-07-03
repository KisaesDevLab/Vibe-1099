/**
 * Env schema validation — fail-fast boot (Phase 1).
 */
import { z } from 'zod';

const zEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379/3'),
  API_PORT: z.coerce.number().int().default(8210),

  MASTER_KEY: z
    .string()
    .refine((s) => {
      try {
        return Buffer.from(s, 'base64').length === 32;
      } catch {
        return false;
      }
    }, 'MASTER_KEY must be 32 bytes base64'),

  APP_BASE_URL: z.string().url().default('http://localhost:8211'),
  PORTAL_BASE_URL: z.string().url().default('http://localhost:8211'),
  RENDER_URL: z.string().url().default('http://localhost:8212'),

  LICENSE_REQUIRED: z.coerce.number().int().default(0),
  LICENSE_SERVER_URL: z.string().default('https://licensing.kisaes.com'),

  // appliance-level email default (firms can override in Settings). 'env' resolves
  // to SMTP if SMTP_HOST is set, else EmailIt if EMAILIT_API_KEY is set, else null.
  EMAIL_PROVIDER: z.enum(['auto', 'smtp', 'emailit', 'none']).default('auto'),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  SMTP_FROM: z.string().default('Vibe 1099 <no-reply@localhost>'),
  SMTP_SECURE: z.coerce.number().int().default(0),
  EMAILIT_API_KEY: z.string().default(''),
  EMAILIT_FROM: z.string().default(''),

  SMS_PROVIDER: z.enum(['none', 'textlink', 'twilio']).default('none'),
  TEXTLINK_API_KEY: z.string().default(''),
  TWILIO_ACCOUNT_SID: z.string().default(''),
  TWILIO_AUTH_TOKEN: z.string().default(''),
  TWILIO_FROM_NUMBER: z.string().default(''),

  IRIS_ATS_BASE_URL: z.string().default('https://la.alt.www4.irs.gov/iris'),
  IRIS_PROD_BASE_URL: z.string().default('https://la.www4.irs.gov/iris'),
  IRIS_MOCK_BASE_URL: z.string().default(''),

  // Tax1099 (Zenwork) managed-filing backend — used when a firm/payer selects
  // provider 'tax1099'. Point *_MOCK_BASE_URL at the mock server for testing.
  TAX1099_SANDBOX_BASE_URL: z.string().default('https://api.sandbox.tax1099.com'),
  TAX1099_PROD_BASE_URL: z.string().default('https://api.tax1099.com'),
  TAX1099_MOCK_BASE_URL: z.string().default(''),

  // Number of trusted reverse-proxy hops in front of the API (Express trust proxy).
  // Per-IP rate limiting keys on the resolved client IP, so this MUST match the
  // real topology or req.ip collapses to the proxy address (global throttle) or
  // trusts a spoofable X-Forwarded-For. Cloudflare Tunnel + Caddy = 2 hops.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(2),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SESSION_INACTIVITY_MINUTES: z.coerce.number().int().default(30),
  STAFF_IP_ALLOWLIST: z.string().default(''),
  DATA_RETENTION_YEARS: z.coerce.number().int().default(4),
});

export type Env = z.infer<typeof zEnv>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = zEnv.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    // fail fast, no partial boot
    throw new Error(`Environment validation failed:\n${lines}`);
  }
  cached = parsed.data;
  return cached;
}

/** test helper */
export function resetEnvCache(): void {
  cached = undefined;
}
