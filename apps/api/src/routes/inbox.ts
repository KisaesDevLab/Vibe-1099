/**
 * Work Inbox (Phase B): one prioritized, paginated, filterable queue unifying
 * every "needs a human" signal — client submissions to review, rejected records,
 * missing/stale W-9, missing address — with bulk-resolve actions.
 */
import { Router } from 'express';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { zTaxYear } from '@vibe1099/shared';
import { formRecords, getDb, payers, recipients } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { requireStaff } from '../middleware/auth.js';

export const inboxRouter = Router();
inboxRouter.use(requireStaff());

type InboxKind = 'review' | 'rejected' | 'missing_w9' | 'missing_address';

interface InboxItem {
  kind: InboxKind;
  priority: number; // lower = more urgent
  formRecordId?: string;
  recipientId?: string;
  payerId?: string;
  title: string;
  detail: string;
}

inboxRouter.get(
  '/:taxYear',
  h(async (req, res) => {
    const taxYear = zTaxYear.parse(Number(req.params['taxYear']));
    const q = z
      .object({
        kinds: z.string().optional(), // csv filter
        payerId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const db = getDb();
    const firmId = req.staff!.firmId;
    const wantKinds = q.kinds ? new Set(q.kinds.split(',')) : null;
    const items: InboxItem[] = [];

    const payerFilter = q.payerId ? [eq(formRecords.payerId, q.payerId)] : [];

    // rejected records (most urgent)
    if (!wantKinds || wantKinds.has('rejected')) {
      const rows = await db
        .select({ f: formRecords, recipientName: recipients.name1, payerName: payers.legalName })
        .from(formRecords)
        .innerJoin(recipients, eq(recipients.id, formRecords.recipientId))
        .innerJoin(payers, eq(payers.id, formRecords.payerId))
        .where(and(eq(formRecords.firmId, firmId), eq(formRecords.taxYear, taxYear), eq(formRecords.status, 'rejected'), ...payerFilter));
      for (const { f, recipientName, payerName } of rows) {
        items.push({
          kind: 'rejected',
          priority: 0,
          formRecordId: f.id,
          payerId: f.payerId,
          title: `Rejected 1099-${f.formType}: ${recipientName}`,
          detail: `${payerName} — ${(f.recordErrors ?? []).map((e) => e.translated ?? e.message).join('; ') || 'rejected by IRS'}`,
        });
      }
    }

    // client submissions to review
    if (!wantKinds || wantKinds.has('review')) {
      const rows = await db
        .select({ f: formRecords, payerName: payers.legalName })
        .from(formRecords)
        .innerJoin(payers, eq(payers.id, formRecords.payerId))
        .where(and(eq(formRecords.firmId, firmId), eq(formRecords.taxYear, taxYear), eq(formRecords.clientSubmitted, true), eq(formRecords.status, 'draft'), ...payerFilter));
      // group by payer for the engagement view
      const byPayer = new Map<string, { name: string; n: number }>();
      for (const { f, payerName } of rows) {
        const g = byPayer.get(f.payerId) ?? { name: payerName, n: 0 };
        g.n++;
        byPayer.set(f.payerId, g);
      }
      for (const [payerId, g] of byPayer) {
        items.push({ kind: 'review', priority: 1, payerId, title: `Review ${g.n} client-submitted form(s)`, detail: `${g.name} submitted an engagement for review` });
      }
    }

    // recipients (active this year) with missing W-9 / address
    const activeRecipientIds = db
      .selectDistinct({ rid: formRecords.recipientId })
      .from(formRecords)
      .where(and(eq(formRecords.firmId, firmId), eq(formRecords.taxYear, taxYear), ...payerFilter));

    if (!wantKinds || wantKinds.has('missing_w9')) {
      const rows = await db
        .select({ id: recipients.id, name1: recipients.name1, w9Status: recipients.w9Status })
        .from(recipients)
        .where(and(eq(recipients.firmId, firmId), isNull(recipients.mergedIntoId), inArray(recipients.w9Status, ['none', 'stale']), sql`${recipients.id} IN ${activeRecipientIds}`));
      for (const r of rows) items.push({ kind: 'missing_w9', priority: 2, recipientId: r.id, title: `W-9 ${r.w9Status === 'stale' ? 'stale' : 'missing'}: ${r.name1}`, detail: 'Request a W-9' });
    }
    if (!wantKinds || wantKinds.has('missing_address')) {
      const rows = await db
        .select({ id: recipients.id, name1: recipients.name1 })
        .from(recipients)
        .where(and(eq(recipients.firmId, firmId), isNull(recipients.mergedIntoId), sql`${recipients.id} IN ${activeRecipientIds}`, sql`((${recipients.address}->>'line1') IS NULL OR (${recipients.address}->>'line1') = '' OR (${recipients.address}->>'zip') IS NULL OR (${recipients.address}->>'zip') = '')`));
      for (const r of rows) items.push({ kind: 'missing_address', priority: 3, recipientId: r.id, title: `Missing address: ${r.name1}`, detail: 'Complete the recipient address before filing' });
    }

    items.sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));
    const counts = items.reduce<Record<string, number>>((acc, it) => { acc[it.kind] = (acc[it.kind] ?? 0) + 1; return acc; }, {});
    res.json({ items: items.slice(q.offset, q.offset + q.limit), total: items.length, counts, limit: q.limit, offset: q.offset });
  }),
);
