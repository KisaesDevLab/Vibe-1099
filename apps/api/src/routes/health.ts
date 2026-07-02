/**
 * Health + version/about endpoints (Phase 1) and appliance status page data
 * (Phase 12): queue depth, render sidecar, IRIS reachability, DB/Redis.
 */
import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { getQueue, getRedis, getRenderClient, loadEnv, QUEUE_NAMES, type QueueName } from '@vibe1099/core';
import { getDb } from '@vibe1099/db';
import { h } from '../middleware/error.js';

export const APP_VERSION = '0.1.0';

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
      license: 'PolyForm Internal Use 1.0.0 (commercial license required for client-portal access)',
      vendor: 'Kisaes LLC / KisaesDevLab',
    });
  }),
);

healthRouter.get(
  '/status',
  h(async (_req, res) => {
    const env = loadEnv();
    const checks: Record<string, unknown> = {};

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

    // IRIS reachability: DNS/TCP-level probe of the configured environment base
    const irisBase = env.IRIS_MOCK_BASE_URL || env.IRIS_ATS_BASE_URL;
    try {
      const probe = await fetch(irisBase, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
      checks['iris'] = { ok: probe.status < 600, status: probe.status };
    } catch (err) {
      checks['iris'] = { ok: false, error: (err as Error).message };
    }

    const allOk = Object.values(checks).every((c) => (c as { ok: boolean }).ok);
    res.status(allOk ? 200 : 503).json({ ok: allOk, version: APP_VERSION, checks });
  }),
);
