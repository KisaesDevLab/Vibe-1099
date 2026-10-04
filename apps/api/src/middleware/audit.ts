/**
 * Audit middleware — logs all mutations with actor + entity inference (Phase 2).
 * Route handlers can enrich via res.locals.audit = { action, entityType, entityId, before, after }.
 */
import type { NextFunction, Request, Response } from 'express';
import { audit, createLogger } from '@vibe1099/core';
import { getDb } from '@vibe1099/db';

const log = createLogger('audit');

export function auditMutations() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (['HEAD', 'OPTIONS'].includes(req.method)) return next();
    const readOnly = req.method === 'GET';
    res.on('finish', () => {
      if (res.statusCode >= 400) return; // only successful mutations
      // A handler that wrote its own audit row(s) opts out of the generic one;
      // a GET is audited only when its handler says it mutated something
      // (e.g. a status check that enqueues work) by setting res.locals.audit.
      if (res.locals['audit'] === false) return;
      if (readOnly && !res.locals['audit']) return;
      const enriched = (res.locals['audit'] ?? {}) as Partial<{
        action: string;
        entityType: string;
        entityId: string;
        before: unknown;
        after: unknown;
        detail: Record<string, unknown>;
      }>;
      const actorType = req.staff ? 'staff' : req.clientScope ? 'client' : req.recipientScope ? 'recipient' : 'system';
      const actorId = req.staff?.userId ?? req.clientScope?.inviteId ?? req.recipientScope?.deliveryId ?? null;
      const firmId = req.staff?.firmId ?? req.clientScope?.firmId ?? req.recipientScope?.firmId ?? null;
      void audit(getDb(), {
        firmId,
        actorType,
        actorId,
        action: enriched.action ?? `${req.method} ${req.route?.path ?? req.path}`,
        entityType: enriched.entityType ?? 'http',
        entityId: enriched.entityId ?? null,
        before: enriched.before,
        after: enriched.after,
        detail: enriched.detail,
        ip: req.ip,
      }).catch((err: unknown) => {
        // Never break the request, but a dropped audit row must NOT be silent —
        // it is a monitoring gap (FTC Safeguards 314.4(c)). Emit at error level so
        // it surfaces in log alerting and can be reconciled.
        log.error(
          { err, action: enriched.action, entityType: enriched.entityType, entityId: enriched.entityId, actorType, firmId },
          'AUDIT WRITE FAILED — mutation committed without an audit row',
        );
      });
    });
    next();
  };
}
