/**
 * Express app assembly — security headers (helmet), strict CSP on portal
 * routes, request IDs, structured logging with PII redaction, audit middleware,
 * trust-zone route mounting (staff LAN vs public tunnel paths).
 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { createLogger, loadEnv } from '@vibe1099/core';
import './types.js';
import { errorHandler } from './middleware/error.js';
import { auditMutations } from './middleware/audit.js';
import { staffIpAllowlist } from './middleware/auth.js';
import { authRouter } from './routes/auth.js';
import { payersRouter } from './routes/payers.js';
import { recipientsRouter } from './routes/recipients.js';
import { formsRouter } from './routes/forms.js';
import { invitesRouter } from './routes/invites.js';
import { clientPortalRouter } from './routes/client-portal.js';
import { recipientPortalRouter } from './routes/recipient-portal.js';
import { w9PublicRouter, w9StaffRouter } from './routes/w9.js';
import { deliveriesRouter } from './routes/deliveries.js';
import { batchesRouter } from './routes/batches.js';
import { irisRouter } from './routes/iris.js';
import { moRouter } from './routes/mo.js';
import { correctionsRouter } from './routes/corrections.js';
import { dashboardRouter } from './routes/dashboard.js';
import { adminRouter } from './routes/admin.js';
import { healthRouter } from './routes/health.js';
import { runsRouter } from './routes/runs.js';
import { inboxRouter } from './routes/inbox.js';
import { notificationsRouter } from './routes/notifications.js';
import { searchRouter, viewsRouter } from './routes/views.js';

export function createApp(): express.Express {
  const app = express();
  // exact trusted hop count (Cloudflare Tunnel + Caddy = 2 by default) so req.ip
  // resolves to the real client and per-IP rate limits can't be spoofed/collapsed
  app.set('trust proxy', loadEnv().TRUST_PROXY_HOPS);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-origin' },
    }),
  );

  app.use((req, _res, next) => {
    req.requestId = randomUUID();
    next();
  });
  app.use(
    pinoHttp({
      logger: createLogger('api'),
      genReqId: (req) => (req as express.Request).requestId ?? randomUUID(),
      autoLogging: { ignore: (req) => req.url === '/api/health' },
    }),
  );

  app.use(express.json({ limit: '10mb' })); // CSV imports + drawn signatures
  app.use(cookieParser());
  app.use(auditMutations());

  // health/version — unauthenticated (appliance console probes)
  app.use('/api', healthRouter);

  // PUBLIC zone (Cloudflare Tunnel): recipient portal, W-9, client portal
  app.use('/api/portal', recipientPortalRouter);
  app.use('/api/w9-public', w9PublicRouter);
  app.use('/api/client-portal', clientPortalRouter);

  // STAFF zone (LAN / Tailscale; optional IP allowlist)
  const staff = express.Router();
  staff.use(staffIpAllowlist());
  staff.use('/auth', authRouter);
  staff.use('/payers', payersRouter);
  staff.use('/recipients', recipientsRouter);
  staff.use('/forms', formsRouter);
  staff.use('/invites', invitesRouter);
  staff.use('/w9', w9StaffRouter);
  staff.use('/deliveries', deliveriesRouter);
  staff.use('/batches', batchesRouter);
  staff.use('/iris', irisRouter);
  staff.use('/mo', moRouter);
  staff.use('/corrections', correctionsRouter);
  staff.use('/dashboard', dashboardRouter);
  staff.use('/admin', adminRouter);
  staff.use('/runs', runsRouter);
  staff.use('/inbox', inboxRouter);
  staff.use('/notifications', notificationsRouter);
  staff.use('/views', viewsRouter);
  staff.use('/search', searchRouter);
  app.use('/api', staff);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'E_NOT_FOUND', message: 'Route not found' } });
  });
  app.use(errorHandler);
  return app;
}
