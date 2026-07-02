/**
 * Notification center (Phase B): persistent async-job completions + alerts.
 * Visibility-aware polling from the client; per-user or firm-wide.
 */
import { Router } from 'express';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, notifications } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { requireStaff } from '../middleware/auth.js';

export const notificationsRouter = Router();
notificationsRouter.use(requireStaff());

function mine(firmId: string, userId: string) {
  // firm-wide (user_id null) OR addressed to this user
  return and(eq(notifications.firmId, firmId), or(isNull(notifications.userId), eq(notifications.userId, userId)));
}

notificationsRouter.get(
  '/',
  h(async (req, res) => {
    const rows = await getDb()
      .select()
      .from(notifications)
      .where(mine(req.staff!.firmId, req.staff!.userId))
      .orderBy(desc(notifications.createdAt))
      .limit(50);
    res.json({ notifications: rows });
  }),
);

notificationsRouter.get(
  '/unread-count',
  h(async (req, res) => {
    const [row] = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(mine(req.staff!.firmId, req.staff!.userId), isNull(notifications.readAt)));
    res.json({ count: row?.n ?? 0 });
  }),
);

notificationsRouter.post(
  '/:id/read',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    await getDb().update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.id, id), eq(notifications.firmId, req.staff!.firmId)));
    res.json({ ok: true });
  }),
);

notificationsRouter.post(
  '/read-all',
  h(async (req, res) => {
    await getDb()
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(mine(req.staff!.firmId, req.staff!.userId), isNull(notifications.readAt)));
    res.json({ ok: true });
  }),
);
