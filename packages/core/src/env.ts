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
  // Opt-out of the production https-only interlock for APP_BASE_URL /
  // PORTAL_BASE_URL ONLY — never for IRS/provider endpoints. For deployments
  // whose own base URLs are legitimately plain HTTP: the Vibe Appliance's LAN
  // mode (http://<lan-ip>:<port>, never leaves the office network) and its
  // Tailscale mode (plain HTTP inside the WireGuard tunnel). Anything
  // internet-facing must leave this unset and use https.
  ALLOW_HTTP_BASE_URLS: z.enum(['0', '1']).default('0'),
  RENDER_URL: z.string().url().default('http://localhost:8212'),

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

  // TaxBandits (SPAN Enterprises) managed-filing backend — always offered in
  // Settings; gated per-firm by the enable checkbox, credentials, and §7216
  // acknowledgment. Point *_MOCK_BASE_URL at the mock.
  TAXBANDITS_SANDBOX_BASE_URL: z.string().default('https://testapi.taxbandits.com'),
  TAXBANDITS_PROD_BASE_URL: z.string().default('https://api.taxbandits.com'),
  TAXBANDITS_MOCK_BASE_URL: z.string().default(''),
  // OAuth token server is a SEPARATE host from the API (per TaxBandits spec).
  TAXBANDITS_SANDBOX_OAUTH_URL: z.string().default('https://testoauth.expressauth.net/v2/tbsauth'),
  TAXBANDITS_PROD_OAUTH_URL: z.string().default('https://oauth.expressauth.net/v2/tbsauth'),
  // Documented webhook source IPs (comma-separated; ADVISORY — deliveries are
  // authenticated by TaxBandits' HMAC Signature/TimeStamp headers, and an
  // off-list source IP is logged, not rejected).
  TAXBANDITS_WEBHOOK_IPS: z.string().default('34.239.209.88,129.213.79.42,34.194.208.36'),

  // Number of trusted reverse-proxy hops in front of the API (Express trust proxy).
  // Per-IP rate limiting keys on the resolved client IP, so this MUST match the
  // real topology or req.ip collapses to the proxy address (global throttle) or
  // trusts a spoofable X-Forwarded-For. Cloudflare Tunnel + Caddy = 2 hops.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(2),
  // In-app Cloudflare Tunnel management. OFF by default: on the Vibe Appliance,
  // public ingress is handled at the appliance level (shared Caddy + a
  // path-restricted tunnel), so the app must NOT run its own sidecar. Set to 1
  // only for a STANDALONE deployment (with `docker compose --profile tunnel up`),
  // where the app manages the tunnel token itself.
  INAPP_TUNNEL_ENABLED: z.coerce.number().int().default(0),
  // The app writes the token to CLOUDFLARE_TOKEN_FILE (shared volume) which the
  // cloudflared sidecar runs with, and reads the sidecar's metrics for live status.
  CLOUDFLARE_METRICS_URL: z.string().default('http://cloudflared:2000'),
  CLOUDFLARE_TOKEN_FILE: z.string().default('/shared/cloudflared/token'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SESSION_INACTIVITY_MINUTES: z.coerce.number().int().default(30),
  // Absolute session cap regardless of activity (a rolling inactivity TTL alone
  // lets a session live forever if touched often enough). Bounds credential theft.
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).default(12),
  STAFF_IP_ALLOWLIST: z.string().default(''),
  DATA_RETENTION_YEARS: z.coerce.number().int().default(4),
})
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    // Production interlocks — fail the boot rather than silently mis-filing or
    // sending PII in cleartext (H4 / TLS / weak-default findings in the audit).
    if (/:vibe1099@/.test(env.DATABASE_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DATABASE_URL still uses the weak default password "vibe1099" — set POSTGRES_PASSWORD in .env before running in production.',
      });
    }
    if (env.IRIS_MOCK_BASE_URL || env.TAX1099_MOCK_BASE_URL || env.TAXBANDITS_MOCK_BASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'IRIS_MOCK_BASE_URL / TAX1099_MOCK_BASE_URL / TAXBANDITS_MOCK_BASE_URL must be empty in production — a mock base URL would mark returns "accepted" without ever filing them with the IRS.',
      });
    }
    // IRS/provider endpoints: https-only in production, UNCONDITIONALLY.
    // These carry TINs to third parties over the public internet; there is no
    // deployment shape where plain HTTP to the IRS is legitimate.
    const httpsAlways: Array<[keyof typeof env, string]> = [
      ['IRIS_PROD_BASE_URL', env.IRIS_PROD_BASE_URL],
      ['IRIS_ATS_BASE_URL', env.IRIS_ATS_BASE_URL],
      ['TAX1099_PROD_BASE_URL', env.TAX1099_PROD_BASE_URL],
      ['TAX1099_SANDBOX_BASE_URL', env.TAX1099_SANDBOX_BASE_URL],
      ['TAXBANDITS_PROD_BASE_URL', env.TAXBANDITS_PROD_BASE_URL],
      ['TAXBANDITS_SANDBOX_BASE_URL', env.TAXBANDITS_SANDBOX_BASE_URL],
    ];
    // The app's OWN base URLs: same rule by default, but a deployment whose
    // traffic never crosses the public internet may opt out with
    // ALLOW_HTTP_BASE_URLS=1. Concretely: the Vibe Appliance's LAN mode
    // serves http://<lan-ip>:<port> on the office network, and its Tailscale
    // mode serves plain HTTP inside the WireGuard tunnel — in both, an https
    // requirement here doesn't add transport security (there is no public
    // hop), it just makes the app refuse to boot.
    const httpsUnlessOptedOut: Array<[keyof typeof env, string]> =
      env.ALLOW_HTTP_BASE_URLS === '1'
        ? []
        : [
            ['APP_BASE_URL', env.APP_BASE_URL],
            ['PORTAL_BASE_URL', env.PORTAL_BASE_URL],
          ];
    for (const [key, val] of [...httpsAlways, ...httpsUnlessOptedOut]) {
      if (val && !val.startsWith('https://')) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${String(key)} must be https:// in production (got ${val}).` });
      }
    }
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
