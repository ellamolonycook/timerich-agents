import type { OutreachLedger, PodcastTarget, SkipReason } from './types.js';

/**
 * Deliberately conservative. This gate exists to stop obviously undeliverable
 * addresses reaching a reviewer, not to be a full RFC 5322 parser. Address
 * verification is a separate concern and would be an enrichment connector.
 */
const EMAIL_PATTERN = /^[^\s@,;<>"]+@[^\s@,;<>".]+(?:\.[^\s@,;<>".]+)+$/;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email);
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1);
}

/**
 * Builds a do-not-contact matcher. Entries are either full addresses
 * (`sam@example.com`) or domains (`example.com`, `@example.com`); a domain
 * entry suppresses every address at that domain.
 *
 * Blank entries are ignored rather than matching everything.
 */
export function buildSuppressionMatcher(
  entries: readonly string[] = [],
): (email: string) => boolean {
  const addresses = new Set<string>();
  const domains = new Set<string>();

  for (const raw of entries) {
    const entry = normalizeEmail(raw).replace(/^@/, '');
    if (entry === '') continue;
    if (entry.includes('@')) {
      addresses.add(entry);
    } else {
      domains.add(entry);
    }
  }

  return (email: string): boolean => {
    const normalized = normalizeEmail(email);
    return addresses.has(normalized) || domains.has(emailDomain(normalized));
  };
}

export interface ScreeningContext {
  /** Prospect ids already handled earlier in this run. */
  readonly seenProspectIds: ReadonlySet<string>;
  /** Normalised emails already handled earlier in this run. */
  readonly seenEmails: ReadonlySet<string>;
  readonly isSuppressed: (email: string) => boolean;
  readonly ledger: OutreachLedger;
}

export type ScreeningOutcome =
  | { readonly eligible: true; readonly contactEmail: string }
  | { readonly eligible: false; readonly reason: SkipReason; readonly detail?: string };

/**
 * Decides whether a target may be pitched, without composing or sending
 * anything. Ordered cheapest-first so the ledger is only consulted for
 * prospects that have survived every local check.
 *
 * This is a pure decision given its context, which makes each rule directly
 * unit-testable.
 */
export async function screenProspect(
  target: PodcastTarget,
  context: ScreeningContext,
): Promise<ScreeningOutcome> {
  const rawEmail = target.contactEmail?.trim() ?? '';
  if (rawEmail === '') {
    return { eligible: false, reason: 'missing-contact-email' };
  }

  const contactEmail = normalizeEmail(rawEmail);
  if (!isValidEmail(contactEmail)) {
    return { eligible: false, reason: 'invalid-contact-email' };
  }

  if (context.isSuppressed(contactEmail)) {
    return { eligible: false, reason: 'suppressed' };
  }

  if (context.seenProspectIds.has(target.id)) {
    return { eligible: false, reason: 'duplicate-target', detail: 'prospect id seen this run' };
  }
  if (context.seenEmails.has(contactEmail)) {
    return { eligible: false, reason: 'duplicate-target', detail: 'email seen this run' };
  }

  const priorById = await context.ledger.findByProspectId(target.id);
  const prior = priorById ?? (await context.ledger.findByEmail(contactEmail));
  if (prior !== undefined) {
    return {
      eligible: false,
      reason: 'already-contacted',
      detail: `queued as ${prior.approvalId} on ${prior.queuedAt}`,
    };
  }

  return { eligible: true, contactEmail };
}
