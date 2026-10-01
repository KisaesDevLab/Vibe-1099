import { describe, expect, it } from 'vitest';
import { engagementContacts, matchEngagements, normalizeLoginContact, type InviteContactRow } from '../apps/api/src/services/client-login.js';

/**
 * Client sign-in by email/mobile (no invite link). The matcher decides which
 * invites a verified contact may open — a wrong match here is a trust-zone
 * breach (one client seeing another payer), so pin its behavior.
 */
const row = (over: Partial<InviteContactRow>): InviteContactRow => ({
  inviteId: 'inv-1',
  firmId: 'firm-1',
  payerId: 'payer-1',
  taxYear: 2026,
  createdAt: new Date('2026-01-10T00:00:00Z'),
  inviteEmail: null,
  inviteMobile: null,
  payerEmail: null,
  payerMobile: null,
  ...over,
});

describe('normalizeLoginContact', () => {
  it('lower-cases and trims email', () => {
    expect(normalizeLoginContact('  Owner@Acme.COM ')).toEqual({ channel: 'email', value: 'owner@acme.com' });
  });
  it('normalizes US mobile to E.164', () => {
    expect(normalizeLoginContact('(816) 555-0123')).toEqual({ channel: 'sms', value: '+18165550123' });
  });
  it('rejects junk', () => {
    expect(normalizeLoginContact('not-an-email@')).toBeNull();
    expect(normalizeLoginContact('12345')).toBeNull();
    expect(normalizeLoginContact('')).toBeNull();
  });
});

describe('engagementContacts', () => {
  it('lists every code destination once, email first, dropping unusable values', () => {
    expect(engagementContacts({ payerEmail: 'Owner@Acme.com', inviteEmail: 'owner@acme.com', payerMobile: '(816) 555-0123', inviteMobile: 'n/a' })).toEqual([
      { channel: 'email', value: 'owner@acme.com' },
      { channel: 'sms', value: '+18165550123' },
    ]);
    expect(engagementContacts({ payerEmail: null, inviteEmail: null, payerMobile: '816-555-0123', inviteMobile: null })).toEqual([{ channel: 'sms', value: '+18165550123' }]);
    expect(engagementContacts({ payerEmail: null, inviteEmail: null, payerMobile: null, inviteMobile: null })).toEqual([]);
  });
});

describe('matchEngagements', () => {
  const email = normalizeLoginContact('owner@acme.com')!;
  const mobile = normalizeLoginContact('816-555-0123')!;

  it('matches the payer contact regardless of stored formatting', () => {
    expect(matchEngagements(email, [row({ payerEmail: ' Owner@ACME.com' })])).toEqual([{ inviteId: 'inv-1', firmId: 'firm-1' }]);
    expect(matchEngagements(mobile, [row({ payerMobile: '(816) 555-0123' })])).toEqual([{ inviteId: 'inv-1', firmId: 'firm-1' }]);
  });

  it('never matches another payer, a near-miss, or an unusable number on file', () => {
    const rows = [
      row({ inviteId: 'other', payerId: 'payer-2', payerEmail: 'someone@else.com', payerMobile: '816-555-9999' }),
      row({ inviteId: 'near', payerId: 'payer-3', payerEmail: 'owner@acme.com.evil.test' }),
      row({ inviteId: 'bad', payerId: 'payer-4', payerMobile: 'call the office' }),
    ];
    expect(matchEngagements(email, rows)).toEqual([]);
    expect(matchEngagements(mobile, rows)).toEqual([]);
  });

  it('does not match email input against a mobile field or vice versa', () => {
    expect(matchEngagements(mobile, [row({ payerEmail: 'owner@acme.com' })])).toEqual([]);
  });

  it('matches the destination typed on the invite, and a mobile even when an email is on file', () => {
    expect(matchEngagements(normalizeLoginContact('books@acme.com')!, [row({ inviteEmail: 'books@acme.com', payerEmail: 'owner@acme.com' })])).toHaveLength(1);
    expect(matchEngagements(mobile, [row({ payerEmail: 'owner@acme.com', payerMobile: '8165550123' })])).toHaveLength(1);
  });

  it('keeps only the newest invite per payer + tax year, across years and payers', () => {
    const rows = [
      row({ inviteId: 'old', payerEmail: 'owner@acme.com', createdAt: new Date('2026-01-01T00:00:00Z') }),
      row({ inviteId: 'new', payerEmail: 'owner@acme.com', createdAt: new Date('2026-02-01T00:00:00Z') }),
      row({ inviteId: 'prior-year', taxYear: 2025, payerEmail: 'owner@acme.com' }),
      row({ inviteId: 'second-entity', payerId: 'payer-2', payerEmail: 'owner@acme.com' }),
    ];
    expect(matchEngagements(email, rows).map((m) => m.inviteId).sort()).toEqual(['new', 'prior-year', 'second-entity']);
  });
});
