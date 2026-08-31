import { beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryOutreachLedger,
  buildSuppressionMatcher,
  emailDomain,
  isValidEmail,
  normalizeEmail,
  screenProspect,
  type OutreachLedgerEntry,
  type ScreeningContext,
} from '../src/index.js';
import { target } from './harness.js';

describe('email helpers', () => {
  it('normalises case and whitespace', () => {
    expect(normalizeEmail('  Sam@Example.COM ')).toBe('sam@example.com');
  });

  it.each([
    ['sam@example.com', true],
    ['sam.jones+tag@sub.example.co.uk', true],
    ['no-at-sign', false],
    ['missing@domain', false],
    ['spaces in@example.com', false],
    ['two@@example.com', false],
    ['trailing@example.', false],
    ['<sam@example.com>', false],
  ])('validates %s as %s', (email, valid) => {
    expect(isValidEmail(email)).toBe(valid);
  });

  it('extracts the domain', () => {
    expect(emailDomain('sam@example.com')).toBe('example.com');
    expect(emailDomain('broken')).toBe('');
  });
});

describe('buildSuppressionMatcher', () => {
  it('matches full addresses case-insensitively', () => {
    const isSuppressed = buildSuppressionMatcher(['Sam@Example.com']);
    expect(isSuppressed('sam@example.com')).toBe(true);
    expect(isSuppressed('kim@example.com')).toBe(false);
  });

  it('matches every address at a suppressed domain', () => {
    const isSuppressed = buildSuppressionMatcher(['example.com', '@blocked.io']);
    expect(isSuppressed('anyone@example.com')).toBe(true);
    expect(isSuppressed('anyone@blocked.io')).toBe(true);
    expect(isSuppressed('anyone@allowed.com')).toBe(false);
  });

  it('ignores blank entries instead of suppressing everything', () => {
    const isSuppressed = buildSuppressionMatcher(['', '   ', '@']);
    expect(isSuppressed('sam@example.com')).toBe(false);
  });

  it('suppresses nothing when the list is absent', () => {
    expect(buildSuppressionMatcher()('sam@example.com')).toBe(false);
  });
});

describe('screenProspect', () => {
  let ledger: InMemoryOutreachLedger;

  const context = (overrides: Partial<ScreeningContext> = {}): ScreeningContext => ({
    seenProspectIds: new Set<string>(),
    seenEmails: new Set<string>(),
    isSuppressed: () => false,
    ledger,
    ...overrides,
  });

  const priorEntry: OutreachLedgerEntry = {
    prospectId: 't1',
    contactEmail: 'sam@example.com',
    campaignId: 'previous',
    approvalId: 'apr_9',
    runId: 'run_9',
    queuedAt: '2025-12-01T00:00:00.000Z',
  };

  beforeEach(() => {
    ledger = new InMemoryOutreachLedger();
  });

  it('accepts an eligible prospect and returns the normalised email', async () => {
    const outcome = await screenProspect(
      target({ contactEmail: '  Sam@Example.com ' }),
      context(),
    );
    expect(outcome).toEqual({ eligible: true, contactEmail: 'sam@example.com' });
  });

  it('rejects a prospect with no contact email', async () => {
    const outcome = await screenProspect({ id: 't1', showName: 'No Email' }, context());
    expect(outcome).toMatchObject({ eligible: false, reason: 'missing-contact-email' });
  });

  it('rejects a malformed contact email', async () => {
    const outcome = await screenProspect(target({ contactEmail: 'not-an-email' }), context());
    expect(outcome).toMatchObject({ eligible: false, reason: 'invalid-contact-email' });
  });

  it('rejects a suppressed prospect before any dedupe work', async () => {
    const outcome = await screenProspect(
      target(),
      context({ isSuppressed: buildSuppressionMatcher(['example.com']) }),
    );
    expect(outcome).toMatchObject({ eligible: false, reason: 'suppressed' });
  });

  it('rejects a prospect id already seen in this run', async () => {
    const outcome = await screenProspect(
      target(),
      context({ seenProspectIds: new Set(['t1']) }),
    );
    expect(outcome).toMatchObject({ eligible: false, reason: 'duplicate-target' });
  });

  it('rejects an email already seen in this run, under a different id', async () => {
    const outcome = await screenProspect(
      target({ id: 'other' }),
      context({ seenEmails: new Set(['sam@example.com']) }),
    );
    expect(outcome).toMatchObject({
      eligible: false,
      reason: 'duplicate-target',
      detail: 'email seen this run',
    });
  });

  it('rejects a prospect the ledger has already contacted, by id', async () => {
    await ledger.record(priorEntry);
    const outcome = await screenProspect(target({ contactEmail: 'new@example.com' }), context());
    expect(outcome).toMatchObject({ eligible: false, reason: 'already-contacted' });
    if (outcome.eligible) return;
    expect(outcome.detail).toContain('apr_9');
  });

  it('rejects a prospect the ledger has already contacted, by email under a new id', async () => {
    await ledger.record(priorEntry);
    const outcome = await screenProspect(target({ id: 'brand-new' }), context());
    expect(outcome).toMatchObject({ eligible: false, reason: 'already-contacted' });
  });

  it('checks suppression before the ledger, so a blocked domain never hits storage', async () => {
    let ledgerReads = 0;
    const countingLedger: ScreeningContext['ledger'] = {
      findByProspectId: async () => {
        ledgerReads += 1;
        return undefined;
      },
      findByEmail: async () => {
        ledgerReads += 1;
        return undefined;
      },
      record: async () => undefined,
    };

    await screenProspect(
      target(),
      context({ isSuppressed: () => true, ledger: countingLedger }),
    );

    expect(ledgerReads).toBe(0);
  });
});

describe('InMemoryOutreachLedger', () => {
  it('finds a recorded entry by id and by normalised email', async () => {
    const ledger = new InMemoryOutreachLedger();
    await ledger.record({
      prospectId: 'p1',
      contactEmail: 'Sam@Example.com',
      campaignId: 'c',
      approvalId: 'apr_1',
      runId: 'run_1',
      queuedAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(ledger.findByProspectId('p1')).resolves.toMatchObject({ approvalId: 'apr_1' });
    await expect(ledger.findByEmail('  SAM@example.com ')).resolves.toMatchObject({
      approvalId: 'apr_1',
    });
    await expect(ledger.findByProspectId('missing')).resolves.toBeUndefined();
  });

  it('keeps the first contact when a prospect is recorded twice', async () => {
    const ledger = new InMemoryOutreachLedger();
    const base = {
      prospectId: 'p1',
      contactEmail: 'sam@example.com',
      campaignId: 'c',
      runId: 'run_1',
      queuedAt: '2026-01-01T00:00:00.000Z',
    };
    await ledger.record({ ...base, approvalId: 'apr_first' });
    await ledger.record({ ...base, approvalId: 'apr_second' });

    await expect(ledger.findByProspectId('p1')).resolves.toMatchObject({
      approvalId: 'apr_first',
    });
    expect(ledger.entries()).toHaveLength(1);
  });

  it('can be seeded with prior history', async () => {
    const ledger = new InMemoryOutreachLedger([
      {
        prospectId: 'seeded',
        contactEmail: 'seed@example.com',
        campaignId: 'c',
        approvalId: 'apr_seed',
        runId: 'run_0',
        queuedAt: '2025-11-01T00:00:00.000Z',
      },
    ]);

    await expect(ledger.findByEmail('seed@example.com')).resolves.toBeDefined();
  });
});
