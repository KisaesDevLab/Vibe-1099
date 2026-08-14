/**
 * Health + version/about endpoints (Phase 1) and appliance status page data
 * (Phase 12): queue depth, render sidecar, IRIS reachability, DB/Redis.
 */
import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { getQueue, getRedis, getRenderClient, loadEnv, QUEUE_NAMES, type QueueName } from '@vibe1099/core';
import { getDb } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { computeApplianceHealth, type StatusCheck } from './appliance-health.js';

export const APP_VERSION = '0.1.22';

export const healthRouter = Router();

healthRouter.get(
  '/health',
  h(async (_req, res) => {
    // liveness: cheap
    res.json({ ok: true });
  }),
);

healthRouter.get(
  '/about',
  h(async (_req, res) => {
    res.json({
      name: 'Vibe 1099',
      version: APP_VERSION,
      license: 'MIT',
      vendor: 'Kisaes LLC / KisaesDevLab',
    });
  }),
);

healthRouter.get(
  '/status',
  h(async (_req, res) => {
    const env = loadEnv();
    const checks: Record<string, StatusCheck> = {};

    try {
      await getDb().execute(sql`SELECT 1`);
      checks['postgres'] = { ok: true };
    } catch (err) {
      checks['postgres'] = { ok: false, error: (err as Error).message };
    }
    try {
      await getRedis().ping();
      checks['redis'] = { ok: true };
    } catch (err) {
      checks['redis'] = { ok: false, error: (err as Error).message };
    }
    checks['render'] = { ok: await getRenderClient().health() };

    const queues: Record<string, unknown> = {};
    try {
      for (const name of Object.values(QUEUE_NAMES)) {
        queues[name] = await getQueue(name as QueueName).getJobCounts('waiting', 'active', 'failed');
      }
      checks['queues'] = { ok: true, depth: queues };
    } catch (err) {
      checks['queues'] = { ok: false, error: (err as Error).message };
    }

    // IRIS reachability — INFORMATIONAL ONLY (see computeApplianceHealth). A
    // DNS/TCP-level probe of the configured IRIS environment, reported for
    // operators but never gating appliance health: the IRS endpoint is
    // unreachable by default (pre-enrollment) and on restricted-egress
    // appliances, and its outages are not this app's health. Short timeout so a
    // slow/unreachable IRS never stalls the console's health poll.
    const irisBase = env.IRIS_MOCK_BASE_URL || env.IRIS_ATS_BASE_URL;
    try {
      const probe = await fetch(irisBase, { method: 'HEAD', signal: AbortSignal.timeout(2500) });
      checks['iris'] = { ok: probe.status < 600, status: probe.status, informational: true };
    } catch (err) {
      checks['iris'] = { ok: false, error: (err as Error).message, informational: true };
    }

    const allOk = computeApplianceHealth(checks);
    res.status(allOk ? 200 : 503).json({ ok: allOk, version: APP_VERSION, checks });
  }),
);
