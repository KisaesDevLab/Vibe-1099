/**
 * Admin: firm settings, audit log viewer + export, queue dashboard (staff-only),
 * imposition calibration, retention.
 */
import { Router } from 'express';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '@vibe1099/shared';
import { getCrypto, getQueue, loadEnv, QUEUE_NAMES, resolveEmailAdapter, resolveSmsAdapter, toE164, type QueueName } from '@vibe1099/core';
import { auditLog, firms, getDb } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { requireStaff } from '../middleware/auth.js';
import { addFilingYear, allSettings, getFilingYears, setCurrentFilingYear, setSetting } from '../services/settings.js';
import { resetFirmData } from '../services/reset-data.js';
import { seedSandboxData } from '../services/sandbox-seed.js';
import { getCloudflareConfig, PUBLIC_PATHS, saveCloudflareConfig, tunnelStatus } from '../services/cloudflare.js';

export const adminRouter = Router();

// --- Cloudflare Tunnel (public ingress) -----------------------------------------
adminRouter.get(
  '/cloudflare',
  requireStaff('admin'),
  h(async (_req, res) => {
    const inAppTunnel = loadEnv().INAPP_TUNNEL_ENABLED === 1;
    const [config, status] = await Promise.all([getCloudflareConfig(), inAppTunnel ? tunnelStatus() : Promise.resolve(null)]);
    res.json({
      ...config,
      inAppTunnel,
      status,
      publicPaths: PUBLIC_PATHS,
      portalBaseUrl: loadEnv().PORTAL_BASE_URL,
    });
  }),
);

adminRouter.put(
  '/cloudflare',
  requireStaff('admin'),
  h(async (req, res) => {
    if (loadEnv().INAPP_TUNNEL_ENABLED !== 1) {
      throw AppError.validation('In-app tunnel management is off. On the Vibe Appliance, configure ingress at the appliance level (Caddy). For a standalone deployment, set INAPP_TUNNEL_ENABLED=1 and run with --profile tunnel.');
    }
    const input = z
      .object({ token: z.string().max(4000).optional(), hostname: z.string().max(253).optional() })
      .parse(req.body);
    const result = await saveCloudflareConfig(input);
    res.locals['audit'] = {
      action: 'cloudflare.config',
      entityType: 'app_settings',
      entityId: 'cloudflare',
      detail: { tokenSet: !!input.token, tokenWritten: result.tokenWritten, hostnameSet: input.hostname !== undefined },
    };
    res.json({ ok: true, ...result });
  }),
);

const RESET_CONFIRM_PHRASE = 'REMOVE TEST DATA';

// --- remove test data (admin, destructive, confirmation-gated) -------------------
adminRouter.post(
  '/reset-test-data',
  requireStaff('admin'),
  h(async (req, res) => {
    const { confirm } = z.object({ confirm: z.string() }).parse(req.body);
    if (confirm !== RESET_CONFIRM_PHRASE) {
      throw AppError.validation(`Type "${RESET_CONFIRM_PHRASE}" to confirm — this permanently deletes all payers, recipients, forms, and filings for this firm.`);
    }
    const counts = await resetFirmData(getDb(), req.staff!.firmId);
    res.locals['audit'] = { action: 'firm.reset-test-data', entityType: 'firm', entityId: req.staff!.firmId, detail: counts };
    res.json({ ok: true, deleted: counts });
  }),
);

// --- delivery self-test (admin) ---------------------------------------------------
/**
 * Send a real test message through the SAME adapter resolution the delivery
 * worker uses (core delivery/resolve.ts), so a pass here means real sends work.
 * Synchronous on purpose: the operator needs the provider's actual error text,
 * not a queued job they have to go hunting for. Errors are returned verbatim
 * (staff zone) because that string is the whole diagnostic value.
 */
adminRouter.post(
  '/test-message',
  requireStaff('admin'),
  h(async (req, res) => {
    const { channel, to } = z
      .object({ channel: z.enum(['email', 'sms']), to: z.string().min(3).max(254) })
      .parse(req.body);
    const db = getDb();
    const firmId = req.staff!.firmId;
    const firm = await db.query.firms.findFirst({ where: eq(firms.id, firmId) });
    const stamp = new Date().toLocaleString();
    const started = Date.now();
    // The no-op adapter silently swallows sends. Reporting that as success is
    // worse than failing: staff would believe delivery works while every invite
    // and portal link quietly goes nowhere.
    const notConfigured = (adapterName: string): boolean => adapterName === 'null';
    try {
      if (channel === 'email') {
        const emailer = await resolveEmailAdapter(db, firmId);
        if (notConfigured(emailer.name)) {
          return void res.json({
            ok: false,
            channel,
            adapter: emailer.name,
            ms: Date.now() - started,
            error:
              'No email provider is configured, so nothing was sent — the message went to a no-op adapter. Choose EmailIt or SMTP above (or configure the appliance environment), save, then test again.',
          });
        }
        await emailer.send({
          to,
          subject: `Vibe 1099 test message — ${firm?.name ?? 'your firm'}`,
          text:
            `This is a test message from Vibe 1099 (${stamp}).\n\n` +
            `If you received it, your email settings are working and client invites, ` +
            `recipient portal links, and W-9 requests will send.\n\nNo action is needed.`,
        });
        res.locals['audit'] = { action: 'settings.test-message', entityType: 'firm', entityId: firmId, detail: { channel, ms: Date.now() - started } };
        return void res.json({ ok: true, channel, adapter: emailer.name, ms: Date.now() - started });
      }
      const sms = await resolveSmsAdapter(db, firmId);
      if (notConfigured(sms.name)) {
        return void res.json({
          ok: false,
          channel,
          adapter: sms.name,
          ms: Date.now() - started,
          error:
            'No SMS provider is configured, so nothing was sent — the message went to a no-op adapter. Choose TextLink or Twilio above (or configure the appliance environment), save, then test again.',
        });
      }
      await sms.send({ to: toE164(to), body: `Vibe 1099 test message (${stamp}). Your SMS settings are working.` });
      res.locals['audit'] = { action: 'settings.test-message', entityType: 'firm', entityId: firmId, detail: { channel, ms: Date.now() - started } };
      res.json({ ok: true, channel, adapter: sms.name, ms: Date.now() - started });
    } catch (err) {
      // A failed test is a normal outcome, not a server fault — return 200 with
      // the provider's message so the UI can show it inline.
      res.json({ ok: false, channel, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
    }
  }),
);

// --- TaxBandits sandbox test data (admin; refuses in production env) --------------
adminRouter.post(
  '/sandbox-seed',
  requireStaff('admin'),
  h(async (req, res) => {
    const { priorYear } = z.object({ priorYear: z.boolean().default(false) }).parse(req.body);
    const counts = await seedSandboxData(getDb(), req.staff!.firmId, { priorYear });
    res.locals['audit'] = { action: 'firm.sandbox-seed', entityType: 'firm', entityId: req.staff!.firmId, detail: counts };
    res.json({ ok: true, taxYear: counts.taxYear, priorYear, created: counts });
  }),
);

// --- firm profile (any staff can read; admin writes) ------------------------------

adminRouter.get(
  '/firm',
  requireStaff(),
  h(async (req, res) => {
    const firm = await getDb().query.firms.findFirst({ where: eq(firms.id, req.staff!.firmId) });
    if (!firm) throw AppError.notFound('Firm');
    res.json({
      firm: {
        id: firm.id,
        name: firm.name,
        ein: firm.ein,
        address: firm.address,
        phone: firm.phone,
        irisEnvironment: firm.irisEnvironment,
        moWithholdingId: firm.moWithholdingId,
        impositionOffsetX16: firm.impositionOffsetX16,
        impositionOffsetY16: firm.impositionOffsetY16,
      },
    });
  }),
);

adminRouter.put(
  '/firm',
  requireStaff('admin'),
  h(async (req, res) => {
    const input = z
      .object({
        name: z.string().min(1).max(120).optional(),
        ein: z.string().max(11).optional(),
        address: z.record(z.string()).optional(),
        phone: z.string().max(20).optional(),
        moWithholdingId: z.string().max(14).optional(),
        impositionOffsetX16: z.number().int().min(-16).max(16).optional(),
        impositionOffsetY16: z.number().int().min(-16).max(16).optional(),
      })
      .parse(req.body);
    await getDb()
      .update(firms)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(firms.id, req.staff!.firmId));
    res.locals['audit'] = { action: 'firm.update', entityType: 'firm', entityId: req.staff!.firmId, detail: { fields: Object.keys(input) } };
    res.json({ ok: true });
  }),
);

// --- SMS provider (firm-level, secrets encrypted at rest) ---------------------------

adminRouter.get(
  '/sms',
  requireStaff('admin'),
  h(async (req, res) => {
    const firm = await getDb().query.firms.findFirst({ where: eq(firms.id, req.staff!.firmId) });
    const o = (firm?.smsOverride ?? {}) as Record<string, string>;
    res.json({
      provider: o['provider'] ?? 'env',
      hasTextlinkKey: !!o['textlinkApiKeyEncrypted'],
      hasTwilioAuth: !!o['twilioAuthTokenEncrypted'],
      twilioAccountSid: o['twilioAccountSid'] ?? '',
      twilioFromNumber: o['twilioFromNumber'] ?? '',
      envProvider: loadEnv().SMS_PROVIDER,
    });
  }),
);

adminRouter.put(
  '/sms',
  requireStaff('admin'),
  h(async (req, res) => {
    const input = z
      .object({
        provider: z.enum(['env', 'none', 'textlink', 'twilio']),
        textlinkApiKey: z.string().max(300).optional(),
        twilioAccountSid: z.string().max(100).optional(),
        twilioAuthToken: z.string().max(300).optional(),
        twilioFromNumber: z.string().max(20).optional(),
      })
      .parse(req.body);
    const db = getDb();
    if (input.provider === 'env') {
      // clear the override — fall back to appliance-level env config
      await db.update(firms).set({ smsOverride: null, updatedAt: new Date() }).where(eq(firms.id, req.staff!.firmId));
    } else {
      const firm = await db.query.firms.findFirst({ where: eq(firms.id, req.staff!.firmId) });
      const prev = (firm?.smsOverride ?? {}) as Record<string, string>;
      const crypto = getCrypto();
      const next: Record<string, string> = { provider: input.provider };
      if (input.provider === 'textlink') {
        const key = input.textlinkApiKey ?? '';
        next['textlinkApiKeyEncrypted'] = key ? crypto.encrypt(key) : (prev['textlinkApiKeyEncrypted'] ?? '');
        if (!next['textlinkApiKeyEncrypted']) throw AppError.validation('TextLink API key required');
      } else if (input.provider === 'twilio') {
        next['twilioAccountSid'] = input.twilioAccountSid ?? prev['twilioAccountSid'] ?? '';
        next['twilioFromNumber'] = input.twilioFromNumber ?? prev['twilioFromNumber'] ?? '';
        const token = input.twilioAuthToken ?? '';
        next['twilioAuthTokenEncrypted'] = token ? crypto.encrypt(token) : (prev['twilioAuthTokenEncrypted'] ?? '');
        if (!next['twilioAccountSid'] || !next['twilioAuthTokenEncrypted'] || !next['twilioFromNumber']) {
          throw AppError.validation('Twilio requires Account SID, auth token, and from-number');
        }
      }
      await db.update(firms).set({ smsOverride: next, updatedAt: new Date() }).where(eq(firms.id, req.staff!.firmId));
    }
    res.locals['audit'] = { action: 'sms.configure', entityType: 'firm', entityId: req.staff!.firmId, detail: { provider: input.provider } };
    res.json({ ok: true });
  }),
);

// --- Email provider (firm-level, secrets encrypted at rest) -------------------------

adminRouter.get(
  '/email',
  requireStaff('admin'),
  h(async (req, res) => {
    const firm = await getDb().query.firms.findFirst({ where: eq(firms.id, req.staff!.firmId) });
    const o = (firm?.smtpOverride ?? {}) as Record<string, string>;
    res.json({
      provider: o['provider'] ?? 'env',
      from: o['from'] ?? '',
      replyTo: o['replyTo'] ?? '',
      hasEmailitKey: !!o['emailitApiKeyEncrypted'],
      // smtp
      host: o['host'] ?? '',
      port: o['port'] ?? '587',
      user: o['user'] ?? '',
      hasSmtpPass: !!o['passEncrypted'],
      secure: o['secure'] === '1',
      envProvider: loadEnv().EMAIL_PROVIDER,
    });
  }),
);

adminRouter.put(
  '/email',
  requireStaff('admin'),
  h(async (req, res) => {
    const input = z
      .object({
        provider: z.enum(['env', 'none', 'emailit', 'smtp']),
        from: z.string().max(200).optional(),
        replyTo: z.string().max(200).optional(),
        emailitApiKey: z.string().max(400).optional(),
        host: z.string().max(200).optional(),
        port: z.coerce.number().int().min(1).max(65535).optional(),
        user: z.string().max(200).optional(),
        pass: z.string().max(400).optional(),
        secure: z.boolean().optional(),
      })
      .parse(req.body);
    const db = getDb();
    if (input.provider === 'env') {
      await db.update(firms).set({ smtpOverride: null, updatedAt: new Date() }).where(eq(firms.id, req.staff!.firmId));
      res.locals['audit'] = { action: 'email.configure', entityType: 'firm', entityId: req.staff!.firmId, detail: { provider: 'env' } };
      return void res.json({ ok: true });
    }
    const firm = await db.query.firms.findFirst({ where: eq(firms.id, req.staff!.firmId) });
    const prev = (firm?.smtpOverride ?? {}) as Record<string, string>;
    const crypto = getCrypto();
    const next: Record<string, string> = { provider: input.provider, from: input.from ?? prev['from'] ?? '' };
    if (input.replyTo !== undefined) next['replyTo'] = input.replyTo;
    else if (prev['replyTo']) next['replyTo'] = prev['replyTo'];

    if (input.provider === 'emailit') {
      const key = input.emailitApiKey ?? '';
      next['emailitApiKeyEncrypted'] = key ? crypto.encrypt(key) : (prev['emailitApiKeyEncrypted'] ?? '');
      if (!next['emailitApiKeyEncrypted']) throw AppError.validation('EmailIt API key required');
      if (!next['from']) throw AppError.validation('From address required');
    } else if (input.provider === 'smtp') {
      next['host'] = input.host ?? prev['host'] ?? '';
      next['port'] = String(input.port ?? prev['port'] ?? '587');
      next['user'] = input.user ?? prev['user'] ?? '';
      next['secure'] = (input.secure ?? prev['secure'] === '1') ? '1' : '0';
      const pass = input.pass ?? '';
      next['passEncrypted'] = pass ? crypto.encrypt(pass) : (prev['passEncrypted'] ?? '');
      if (!next['host'] || !next['from']) throw AppError.validation('SMTP requires host and from address');
    }
    await db.update(firms).set({ smtpOverride: next, updatedAt: new Date() }).where(eq(firms.id, req.staff!.firmId));
    res.locals['audit'] = { action: 'email.configure', entityType: 'firm', entityId: req.staff!.firmId, detail: { provider: input.provider } };
    res.json({ ok: true });
  }),
);

// --- filing years (rollover) --------------------------------------------------------

/** Any staff can read enabled years (used to populate year pickers). */
adminRouter.get(
  '/tax-years',
  requireStaff(),
  h(async (_req, res) => {
    res.json(await getFilingYears());
  }),
);

/** Roll forward to a new filing year (defaults to current + 1) and make it current. */
adminRouter.post(
  '/tax-years/rollover',
  requireStaff('admin'),
  h(async (req, res) => {
    const { taxYear } = z.object({ taxYear: z.number().int().optional() }).parse(req.body);
    const cur = await getFilingYears();
    const target = taxYear ?? cur.current + 1;
    const result = await addFilingYear(target);
    res.locals['audit'] = { action: 'tax-year.rollover', entityType: 'firm', entityId: req.staff!.firmId, detail: { taxYear: target } };
    res.status(201).json(result);
  }),
);

/** Change the default ("current") filing year among enabled years. */
adminRouter.put(
  '/tax-years/current',
  requireStaff('admin'),
  h(async (req, res) => {
    const { taxYear } = z.object({ taxYear: z.number().int() }).parse(req.body);
    const result = await setCurrentFilingYear(taxYear);
    res.locals['audit'] = { action: 'tax-year.set-current', entityType: 'firm', entityId: req.staff!.firmId, detail: { taxYear } };
    res.json(result);
  }),
);

// --- app settings -----------------------------------------------------------------

adminRouter.get(
  '/settings',
  requireStaff(),
  h(async (_req, res) => {
    res.json({ settings: await allSettings() });
  }),
);

adminRouter.put(
  '/settings/:key',
  requireStaff('admin'),
  h(async (req, res) => {
    const key = z.string().min(1).max(100).parse(req.params['key']);
    const { value } = z.object({ value: z.unknown() }).parse(req.body);
    // Secrets have dedicated encrypting routes — never accept them here in plaintext.
    if (key === 'cloudflare_tunnel_token') {
      throw AppError.validation('Use the Public access (Cloudflare Tunnel) settings to set this — it is stored encrypted.');
    }
    // Validate settings whose values drive filing correctness — the generic
    // z.unknown() would otherwise let a bad year through into created/filed records.
    if (key === 'filing_years') {
      const zYear = z.number().int().min(2020).max(2100);
      z.object({ years: z.array(zYear).min(1), current: zYear }).parse(value);
    } else if (key === 'data_retention_years') {
      z.number().int().min(4).max(100).parse(value);
    } else if (key === 'document_retention_days') {
      // 0 = disabled. Only regenerable documents are purged on this horizon
      // (see purgeGeneratedDocuments) — filing evidence keeps its years floor.
      z.number().int().min(0).max(3650).parse(value);
    }
    await setSetting(key, value);
    res.locals['audit'] = { action: 'settings.update', entityType: 'app_settings', entityId: key };
    res.json({ ok: true });
  }),
);

// --- audit log viewer with filters + export ------------------------------------------

adminRouter.get(
  '/audit',
  requireStaff('admin'),
  h(async (req, res) => {
    const q = z
      .object({
        action: z.string().optional(),
        entityType: z.string().optional(),
        entityId: z.string().optional(),
        actorType: z.enum(['staff', 'client', 'recipient', 'system']).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(200),
        offset: z.coerce.number().int().min(0).default(0),
        format: z.enum(['json', 'csv']).default('json'),
      })
      .parse(req.query);
    const conds = [eq(auditLog.firmId, req.staff!.firmId)];
    if (q.action) conds.push(sql`${auditLog.action} LIKE ${q.action + '%'}`);
    if (q.entityType) conds.push(eq(auditLog.entityType, q.entityType));
    if (q.entityId) conds.push(eq(auditLog.entityId, q.entityId));
    if (q.actorType) conds.push(eq(auditLog.actorType, q.actorType));
    if (q.from) conds.push(gte(auditLog.createdAt, q.from));
    if (q.to) conds.push(lte(auditLog.createdAt, q.to));
    const rows = await getDb()
      .select()
      .from(auditLog)
      .where(and(...conds))
      .orderBy(desc(auditLog.id))
      .limit(q.limit)
      .offset(q.offset);
    if (q.format === 'csv') {
      const header = 'id,created_at,actor_type,actor_id,action,entity_type,entity_id,ip';
      // CSV-quote, and neutralize spreadsheet formula injection by prefixing any
      // cell that starts with = + - @ (or tab/CR) with a single quote
      const csvCell = (v: unknown): string => {
        let s = String(v);
        if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
        return `"${s.replace(/"/g, '""')}"`;
      };
      const lines = rows.map((r) =>
        [r.id, r.createdAt.toISOString(), r.actorType, r.actorId ?? '', r.action, r.entityType, r.entityId ?? '', r.ip ?? '']
          .map(csvCell)
          .join(','),
      );
      res.setHeader('content-disposition', 'attachment; filename="audit-log.csv"');
      return void res.type('text/csv').send([header, ...lines].join('\n'));
    }
    res.json({ entries: rows });
  }),
);

// --- queue dashboard (staff-only route, Phase 1) ---------------------------------------

adminRouter.get(
  '/queues',
  requireStaff(),
  h(async (_req, res) => {
    const out: Record<string, unknown> = {};
    for (const name of Object.values(QUEUE_NAMES)) {
      const q = getQueue(name as QueueName);
      const counts = await q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
      out[name] = counts;
    }
    res.json({ queues: out });
  }),
);

adminRouter.get(
  '/queues/:name/failed',
  requireStaff('admin'),
  h(async (req, res) => {
    const name = z.enum(['render', 'delivery', 'iris', 'w9', 'housekeeping']).parse(req.params['name']);
    const jobs = await getQueue(name).getFailed(0, 200);
    // BullMQ queues are appliance-global (shared by all firms). Only return this
    // firm's jobs, and NEVER expose raw job.data — it carries other-firm contact
    // info and live portal/W-9 links with working tokens.
    const firmId = req.staff!.firmId;
    res.json({
      failed: jobs
        .filter((j) => (j.data as { firmId?: string } | undefined)?.firmId === firmId)
        .slice(0, 50)
        .map((j) => ({
          id: j.id,
          name: j.name,
          failedReason: j.failedReason,
          attemptsMade: j.attemptsMade,
          // safe, non-sensitive descriptor only — no `to`, no `link`/token, no vars
          kind: (j.data as { kind?: string } | undefined)?.kind ?? null,
          channel: (j.data as { channel?: string } | undefined)?.channel ?? null,
        })),
    });
  }),
);

adminRouter.post(
  '/queues/:name/retry-failed',
  requireStaff('admin'),
  h(async (req, res) => {
    const name = z.enum(['render', 'delivery', 'iris', 'w9', 'housekeeping']).parse(req.params['name']);
    const jobs = await getQueue(name).getFailed(0, 500);
    // only retry this firm's failed jobs
    const firmId = req.staff!.firmId;
    const mine = jobs.filter((j) => (j.data as { firmId?: string } | undefined)?.firmId === firmId);
    for (const j of mine) await j.retry();
    res.locals['audit'] = { action: 'queue.retry-failed', entityType: 'queue', entityId: name, detail: { count: mine.length } };
    res.json({ retried: mine.length });
  }),
);
