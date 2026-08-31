import type { OutreachLedger, OutreachLedgerEntry } from './types.js';
import { normalizeEmail } from './screening.js';

/**
 * Process-local outreach ledger. Suitable for dev and tests; production swaps
 * in a durable `OutreachLedger` without the workflow changing.
 *
 * Scope is deliberately global rather than per-campaign: if we have already
 * queued a pitch to a host, a second campaign should not pitch them again
 * without a human deciding to. See the README for why this is flagged for
 * review.
 */
export class InMemoryOutreachLedger implements OutreachLedger {
  readonly #byProspectId = new Map<string, OutreachLedgerEntry>();
  readonly #byEmail = new Map<string, OutreachLedgerEntry>();

  constructor(seed: readonly OutreachLedgerEntry[] = []) {
    for (const entry of seed) this.#index(entry);
  }

  async findByProspectId(prospectId: string): Promise<OutreachLedgerEntry | undefined> {
    return this.#byProspectId.get(prospectId);
  }

  async findByEmail(email: string): Promise<OutreachLedgerEntry | undefined> {
    return this.#byEmail.get(normalizeEmail(email));
  }

  async record(entry: OutreachLedgerEntry): Promise<void> {
    this.#index(entry);
  }

  /** Everything recorded so far, newest last. For tests and local inspection. */
  entries(): readonly OutreachLedgerEntry[] {
    return [...this.#byProspectId.values()];
  }

  clear(): void {
    this.#byProspectId.clear();
    this.#byEmail.clear();
  }

  #index(entry: OutreachLedgerEntry): void {
    // First contact wins, so a replayed run cannot rewrite history.
    if (!this.#byProspectId.has(entry.prospectId)) {
      this.#byProspectId.set(entry.prospectId, entry);
    }
    const email = normalizeEmail(entry.contactEmail);
    if (!this.#byEmail.has(email)) {
      this.#byEmail.set(email, entry);
    }
  }
}
