import { describe, expect, it } from 'vitest';
import { planClientSubmission, type ExistingRecord } from '../apps/api/src/services/client-submit.js';

/**
 * Client portal submit must never create a second form for the same
 * (recipient, form type) — that duplicate would be filed twice.
 */
const rec = (over: Partial<ExistingRecord>): ExistingRecord => ({
  id: 'f1',
  recipientId: 'r1',
  formType: 'NEC',
  status: 'draft',
  clientSubmitted: false,
  clientInviteId: null,
  ...over,
});
const entry = (recipientId = 'r1', amount = 100) => ({ recipientId, formType: 'NEC', boxValues: { box1: amount } });

describe('planClientSubmission', () => {
  it('inserts when nothing exists', () => {
    const p = planClientSubmission('inv', [entry()], []);
    expect(p.inserts).toHaveLength(1);
    expect(p.updates).toHaveLength(0);
  });

  it('updates a staff-entered draft in place instead of duplicating it', () => {
    const p = planClientSubmission('inv', [entry()], [rec({ id: 'staff' })]);
    expect(p.inserts).toHaveLength(0);
    expect(p.updates).toEqual([{ id: 'staff', entry: entry() }]);
  });

  it('skips forms already past draft (locked)', () => {
    const p = planClientSubmission('inv', [entry()], [rec({ status: 'ready' })]);
    expect(p.inserts).toHaveLength(0);
    expect(p.updates).toHaveLength(0);
    expect(p.skipped).toHaveLength(1);
  });

  it('skips when a ready form exists alongside an old client draft, and leaves the draft for staff', () => {
    const p = planClientSubmission('inv', [entry()], [rec({ id: 'a', status: 'ready' }), rec({ id: 'b', clientSubmitted: true, clientInviteId: 'other' })]);
    expect(p.inserts).toHaveLength(0);
    expect(p.deletes).toHaveLength(0);
  });

  it("reuses this invite's earlier draft and drops other client duplicates", () => {
    const p = planClientSubmission('inv', [entry()], [
      rec({ id: 'other', clientSubmitted: true, clientInviteId: 'inv0' }),
      rec({ id: 'mine', clientSubmitted: true, clientInviteId: 'inv' }),
    ]);
    expect(p.updates.map((u) => u.id)).toEqual(['mine']);
    expect(p.deletes).toEqual(['other']);
  });

  it("deletes this invite's drafts the client cleared, but never staff drafts", () => {
    const p = planClientSubmission('inv', [entry('r1')], [
      rec({ id: 'gone', recipientId: 'r2', clientSubmitted: true, clientInviteId: 'inv' }),
      rec({ id: 'staff', recipientId: 'r3' }),
    ]);
    expect(p.inserts).toHaveLength(1);
    expect(p.deletes).toEqual(['gone']);
  });

  it('collapses a repeated row in one payload', () => {
    const p = planClientSubmission('inv', [entry('r1', 1), entry('r1', 2)], []);
    expect(p.inserts).toHaveLength(1);
  });

  it('keys by form type too', () => {
    const p = planClientSubmission('inv', [{ recipientId: 'r1', formType: 'MISC', boxValues: { box1: 5 } }], [rec({ status: 'ready' })]);
    expect(p.inserts).toHaveLength(1);
  });
});
