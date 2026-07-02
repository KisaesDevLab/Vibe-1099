import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, FORM_STATUSES, isCorrectable, isDeletable, isEditable } from '@vibe1099/shared';

describe('status machine: draft → ready → queued → transmitted → accepted | rejected → corrected(n)', () => {
  it('allows the happy path', () => {
    expect(canTransition('draft', 'ready')).toBe(true);
    expect(canTransition('ready', 'queued')).toBe(true);
    expect(canTransition('queued', 'transmitted')).toBe(true);
    expect(canTransition('transmitted', 'accepted')).toBe(true);
    expect(canTransition('accepted', 'corrected')).toBe(true);
  });

  it('allows rejection → edit → requeue', () => {
    expect(canTransition('transmitted', 'rejected')).toBe(true);
    expect(canTransition('rejected', 'draft')).toBe(true);
  });

  it('allows de-queue and un-ready', () => {
    expect(canTransition('queued', 'ready')).toBe(true);
    expect(canTransition('ready', 'draft')).toBe(true);
  });

  it('blocks illegal jumps', () => {
    expect(canTransition('draft', 'transmitted')).toBe(false);
    expect(canTransition('draft', 'accepted')).toBe(false);
    expect(canTransition('accepted', 'draft')).toBe(false);
    expect(canTransition('corrected', 'draft')).toBe(false);
    expect(() => assertTransition('draft', 'accepted')).toThrow(/Invalid status transition/);
  });

  it('exhaustively guards every pair (no accidental permissiveness)', () => {
    const allowed = new Set([
      'draft>ready',
      'ready>draft',
      'ready>queued',
      'queued>transmitted',
      'queued>ready',
      'transmitted>accepted',
      'transmitted>accepted_with_errors',
      'transmitted>rejected',
      'accepted>corrected',
      'accepted_with_errors>corrected',
      'rejected>draft',
    ]);
    for (const from of FORM_STATUSES) {
      for (const to of FORM_STATUSES) {
        expect(canTransition(from, to), `${from}>${to}`).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });

  it('delete/edit/correct guards', () => {
    expect(isDeletable('draft')).toBe(true);
    expect(isDeletable('ready')).toBe(true);
    expect(isDeletable('transmitted')).toBe(false);
    expect(isEditable('rejected')).toBe(true);
    expect(isEditable('accepted')).toBe(false);
    expect(isCorrectable('accepted')).toBe(true);
    expect(isCorrectable('accepted_with_errors')).toBe(true);
    expect(isCorrectable('draft')).toBe(false);
  });
});
