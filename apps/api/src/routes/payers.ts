/**
 * Payers (the firm's clients issuing 1099s).
 */
import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, formatTin, maskTin, zPayerInput } from '@vibe1099/shared';
import { audit, getCrypto } from '@vibe1099/core';
import { getDb, payers } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { requireStaff } from '../middleware/auth.js';
import { checkTin } from '../services/vault.js';

export const payersRouter = Router();
payersRouter.use(requireStaff());

function toPublicPayer(p: typeof payers.$inferSelect) {
  return {
    id: p.id,
    legalName: p.legalName,
    dbaName: p.dbaName,
    tinMasked: maskTin(p.tinLast4, p.tinType),
    tinType: p.tinType,
    address: p.address,
    phone: p.phone,
    contactEmail: p.contactEmail,
    contactMobile: p.contactMobile,
    moWithholdingId: p.moWithholdingId,
    moSourceDefault: p.moSourceDefault,
    active: p.active,
    createdAt: p.createdAt,
  };
}

payersRouter.get(
  '/',
  h(async (req, res) => {
    const rows = await getDb().query.payers.findMany({
      where: eq(payers.firmId, req.staff!.firmId),
      orderBy: (t, { asc }) => [asc(t.legalName)],
    });
    res.json({ payers: rows.map(toPublicPayer) });
  }),
);

payersRouter.post(
  '/',
  h(async (req, res) => {
    const input = zPayerInput.parse(req.body);
    const { tin } = checkTin(input.tin, input.tinType);
    const crypto = getCrypto();
    const [created] = await getDb()
      .insert(payers)
      .values({
        firmId: req.staff!.firmId,
        legalName: input.legalName,
        dbaName: input.dbaName ?? '',
        tinEncrypted: crypto.encrypt(tin),
        tinType: input.tinType,
        tinLast4: tin.slice(-4),
        address: input.address as unknown as Record<string, string>,
        phone: input.phone ?? '',
        contactEmail: input.contactEmail ?? null,
        contactMobile: input.contactMobile ?? null,
        moWithholdingId: input.moWithholdingId ?? null,
        moSourceDefault: input.moSourceDefault ?? false,
      })
      .returning({ id: payers.id });
    res.locals['audit'] = { action: 'payer.create', entityType: 'payer', entityId: created?.id };
    res.status(201).json({ id: created?.id });
  }),
);

payersRouter.get(
  '/:id',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const row = await getDb().query.payers.findFirst({
      where: and(eq(payers.id, id), eq(payers.firmId, req.staff!.firmId)),
    });
    if (!row) throw AppError.notFound('Payer');
    res.json({ payer: toPublicPayer(row) });
  }),
);

payersRouter.patch(
  '/:id',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const input = zPayerInput.partial().parse(req.body);
    const db = getDb();
    const row = await db.query.payers.findFirst({ where: and(eq(payers.id, id), eq(payers.firmId, req.staff!.firmId)) });
    if (!row) throw AppError.notFound('Payer');

    const patch: Partial<typeof payers.$inferInsert> = { updatedAt: new Date() };
    if (input.legalName !== undefined) patch.legalName = input.legalName;
    if (input.dbaName !== undefined) patch.dbaName = input.dbaName;
    if (input.address !== undefined) patch.address = input.address as unknown as Record<string, string>;
    if (input.phone !== undefined) patch.phone = input.phone;
    if (input.contactEmail !== undefined) patch.contactEmail = input.contactEmail;
    if (input.contactMobile !== undefined) patch.contactMobile = input.contactMobile;
    if (input.moWithholdingId !== undefined) patch.moWithholdingId = input.moWithholdingId;
    if (input.moSourceDefault !== undefined) patch.moSourceDefault = input.moSourceDefault;
    if (input.tin !== undefined) {
      const { tin } = checkTin(input.tin, input.tinType ?? row.tinType);
      patch.tinEncrypted = getCrypto().encrypt(tin);
      patch.tinLast4 = tin.slice(-4);
      if (input.tinType) patch.tinType = input.tinType;
    }
    await db.update(payers).set(patch).where(eq(payers.id, id));
    res.locals['audit'] = { action: 'payer.update', entityType: 'payer', entityId: id };
    res.json({ ok: true });
  }),
);

payersRouter.post(
  '/:id/reveal-tin',
  h(async (req, res) => {
    const id = z.string().uuid().parse(req.params['id']);
    const db = getDb();
    const row = await db.query.payers.findFirst({ where: and(eq(payers.id, id), eq(payers.firmId, req.staff!.firmId)) });
    if (!row) throw AppError.notFound('Payer');
    const tin = getCrypto().decrypt(row.tinEncrypted);
    await audit(db, {
      firmId: req.staff!.firmId,
      actorType: 'staff',
      actorId: req.staff!.userId,
      action: 'tin.reveal',
      entityType: 'payer',
      entityId: id,
      ip: req.ip,
    });
    res.json({ tin: formatTin(tin, row.tinType) });
  }),
);
