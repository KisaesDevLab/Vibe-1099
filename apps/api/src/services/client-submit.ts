/**
 * Client portal submit → form_records reconciliation. One (payer, recipient,
 * tax year, form type) must map to ONE form record: a client submission
 * updates the draft that's already there (staff-entered or an earlier client
 * submission from any invite) instead of inserting a duplicate, and never
 * touches a record staff has advanced past draft (that amount is locked).
 */

export interface SubmitEntry {
  recipientId: string;
  formType: string;
  boxValues: Record<string, number | boolean | string | null>;
}

export interface ExistingRecord {
  id: string;
  recipientId: string;
  formType: string;
  status: string;
  clientSubmitted: boolean;
  clientInviteId: string | null;
}

export interface SubmitPlan {
  inserts: SubmitEntry[];
  updates: Array<{ id: string; entry: SubmitEntry }>;
  /** client-submitted drafts superseded by this submission (stale or duplicate) */
  deletes: string[];
  /** entries whose form is already past draft — left untouched */
  skipped: SubmitEntry[];
}

const keyOf = (r: { recipientId: string; formType: string }) => `${r.formType}:${r.recipientId}`;

export function planClientSubmission(inviteId: string, entries: SubmitEntry[], existing: ExistingRecord[]): SubmitPlan {
  const byKey = new Map<string, ExistingRecord[]>();
  for (const r of existing) {
    const list = byKey.get(keyOf(r)) ?? [];
    list.push(r);
    byKey.set(keyOf(r), list);
  }

  const plan: SubmitPlan = { inserts: [], updates: [], deletes: [], skipped: [] };
  const kept = new Set<string>();
  const seen = new Set<string>();
  for (const e of entries) {
    const key = keyOf(e);
    if (seen.has(key)) continue; // a repeated row in one payload is still one form
    seen.add(key);
    const rows = byKey.get(key) ?? [];
    if (rows.some((r) => r.status !== 'draft')) {
      plan.skipped.push(e);
      continue;
    }
    const drafts = rows.filter((r) => r.status === 'draft');
    const target =
      drafts.find((r) => r.clientInviteId === inviteId) ?? drafts.find((r) => !r.clientSubmitted) ?? drafts[0];
    if (!target) {
      plan.inserts.push(e);
      continue;
    }
    kept.add(target.id);
    plan.updates.push({ id: target.id, entry: e });
    // earlier client-submitted duplicates for the same form go away
    for (const d of drafts) if (d.id !== target.id && d.clientSubmitted) plan.deletes.push(d.id);
  }

  // this invite's earlier drafts the client has since cleared
  for (const r of existing) {
    if (r.clientInviteId === inviteId && r.clientSubmitted && r.status === 'draft' && !kept.has(r.id) && !plan.deletes.includes(r.id)) {
      plan.deletes.push(r.id);
    }
  }
  return plan;
}
