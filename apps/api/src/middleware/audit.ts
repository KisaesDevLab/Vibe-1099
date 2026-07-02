/**
 * Audit middleware — logs all mutations with actor + entity inference (Phase 2).
 * Route handlers can enrich via res.locals.audit = { action, entityType, entityId, before, after }.
 */
import type { NextFunction, Request, Response } from 'express';
import { audit } from '@vibe1099/core';
import { getDb } from '@vibe1099/db';

export function auditMutations() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    res.on('finish', () => {
      if (res.statusCode >= 400) return; // only successful mutations
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
      }).catch(() => {
        /* audit failures never break requests; DB trigger guards integrity */
      });
    });
    next();
  };
}
