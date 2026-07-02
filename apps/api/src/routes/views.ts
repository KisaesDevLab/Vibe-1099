/**
 * Saved views (Phase C): per-user named filter/sort presets + global search
 * powering the command palette.
 */
import { Router } from 'express';
import { and, eq, ilike, or } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, payers, recipients, savedViews } from '@vibe1099/db';
import { maskTin } from '@vibe1099/shared';
import { h } from '../middleware/error.js';
import { requireStaff } from '../middleware/auth.js';

export const viewsRouter = Router();
viewsRouter.use(requireStaff());

viewsRouter.get(
  '/:screen',
  h(async (req, res) => {
    const screen = z.string().min(1).max(40).parse(req.params['screen']);
    const rows = await getDb()
      .select()
      .from(savedViews)
      .where(and(eq(savedViews.firmId, req.staff!.firmId), eq(savedViews.userId, req.staff!.userId), eq(savedViews.screen, screen)));
    res.json({ views: rows });
  }),
);

viewsRouter.post(
  '/',
  h(async (req, res) => {
    const input = z.object({ screen: z.string().min(1).max(40), name: z.string().min(1).max(60), config: z.record(z.unknown()) }).parse(req.body);
    const [row] = await getDb()
      .insert(savedViews)
      .values({ firmId: req.staff!.firmId, userId: req.staff!.userId, screen: input.screen, name: input.name, config: input.config })
      .returning({ id: savedViews.id });
    res.status(201).json({ id: row?.id });
  }),
);

viewsRouter.delete(
  '/:id',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    await getDb().delete(savedViews).where(and(eq(savedViews.id, id), eq(savedViews.userId, req.staff!.userId)));
    res.json({ ok: true });
  }),
);

/** Global search — powers the command palette (jump to any payer/recipient). */
export const searchRouter = Router();
searchRouter.use(requireStaff());

searchRouter.get(
  '/',
  h(async (req, res) => {
    const q = z.object({ q: z.string().min(1).max(80) }).parse(req.query);
    const db = getDb();
    const firmId = req.staff!.firmId;
    const term = `%${q.q}%`;
    const [payerRows, recipRows] = await Promise.all([
      db.select({ id: payers.id, legalName: payers.legalName }).from(payers).where(and(eq(payers.firmId, firmId), or(ilike(payers.legalName, term), ilike(payers.dbaName, term)))).limit(8),
      db
        .select({ id: recipients.id, name1: recipients.name1, tinLast4: recipients.tinLast4, tinType: recipients.tinType })
        .from(recipients)
        .where(and(eq(recipients.firmId, firmId), or(ilike(recipients.name1, term), ilike(recipients.name2, term), eq(recipients.tinLast4, q.q))))
        .limit(8),
    ]);
    res.json({
      results: [
        ...payerRows.map((p) => ({ type: 'payer' as const, id: p.id, label: p.legalName, link: `/forms?payerId=${p.id}&taxYear=2026` })),
        ...recipRows.map((r) => ({ type: 'recipient' as const, id: r.id, label: r.name1, sub: maskTin(r.tinLast4, r.tinType), link: `/recipients` })),
      ],
    });
  }),
);
