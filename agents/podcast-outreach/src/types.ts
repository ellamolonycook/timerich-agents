import type { DataSourceConnector, OutboundChannel } from '@timerich/shared';

// ---------------------------------------------------------------------------
// Prospects
// ---------------------------------------------------------------------------

/** A podcast we are considering pitching, after intake has normalised it. */
export interface PodcastTarget {
  readonly id: string;
  readonly showName: string;
  readonly hostName?: string;
  /** Absent means the target is not contactable yet and will be skipped. */
  readonly contactEmail?: string;
  readonly website?: string;
  /** Why research believes this show is a fit. Shown to the reviewer. */
  readonly relevanceNotes?: string;
}

/**
 * A record exactly as a prospect source returned it. Deliberately untyped:
 * providers differ, and normalising is intake's job, not the caller's.
 */
export type RawProspect = Readonly<Record<string, unknown>>;

export interface ProspectQuery {
  readonly campaignId: string;
  /** Upper bound on records the source should return. */
  readonly limit?: number;
}

/**
 * Prospect sources are ordinary read-only connectors. Using the shared
 * `DataSourceConnector` port means a real provider drops in later without the
 * agent changing, and needs no approval boundary (it sends nothing).
 */
export type ProspectSourceConnector = DataSourceConnector<ProspectQuery, RawProspect>;

/** Ask the workflow to pull prospects from a registered source connector. */
export interface ProspectIntakeRequest {
  readonly connectorId: string;
  readonly query: ProspectQuery;
}

// ---------------------------------------------------------------------------
// Workflow input
// ---------------------------------------------------------------------------

export interface PodcastOutreachInput {
  readonly campaignId: string;
  /** Hard ceiling on approval items this run may create. */
  readonly maxOutreachPerRun: number;
  /** Prospects supplied directly. At least one of `targets`/`intake` required. */
  readonly targets?: readonly PodcastTarget[];
  /** Prospects pulled from a `ProspectSourceConnector`. */
  readonly intake?: ProspectIntakeRequest;
  /**
   * Do-not-contact list. Entries are full email addresses (`sam@example.com`)
   * or domains (`example.com` / `@example.com`). Matched case-insensitively.
   */
  readonly suppress?: readonly string[];
}

// ---------------------------------------------------------------------------
// Workflow output
// ---------------------------------------------------------------------------

export type SkipReason =
  /** A source record could not be normalised into a target. */
  | 'intake-invalid'
  | 'missing-contact-email'
  | 'invalid-contact-email'
  /** On the campaign do-not-contact list. */
  | 'suppressed'
  /** Same prospect id or email already handled earlier in this run. */
  | 'duplicate-target'
  /** Already contacted in an earlier run, per the outreach ledger. */
  | 'already-contacted'
  | 'run-limit-reached'
  /** The outreach rate limit is exhausted; no draft was composed. */
  | 'rate-limited'
  | 'composer-declined'
  /** Guardrails denied the intent. The item is stored as `blocked`. */
  | 'guardrail-blocked';

export interface SkippedTarget {
  readonly targetId: string;
  readonly reason: SkipReason;
  readonly detail?: string;
}

export interface QueuedOutreach {
  readonly targetId: string;
  readonly approvalId: string;
  readonly channel: OutboundChannel;
}

export interface IntakeReport {
  /** Records seen, from inline targets and the source connector combined. */
  readonly received: number;
  /** Records that normalised into a `PodcastTarget`. */
  readonly accepted: number;
  readonly rejected: number;
}

export interface PodcastOutreachOutput {
  readonly campaignId: string;
  readonly intake: IntakeReport;
  /** Targets the workflow screened, including skipped ones. */
  readonly evaluated: number;
  /** Drafts now waiting on a human decision. Nothing has been sent. */
  readonly queued: readonly QueuedOutreach[];
  readonly skipped: readonly SkippedTarget[];
  /** Skip counts by reason, for dashboards and run-over-run comparison. */
  readonly skippedByReason: Readonly<Partial<Record<SkipReason, number>>>;
}

// ---------------------------------------------------------------------------
// Composition port
// ---------------------------------------------------------------------------

export interface OutreachComposeContext {
  readonly campaignId: string;
  readonly agentId: string;
  readonly runId: string;
}

export interface ComposedOutreach {
  readonly subject: string;
  readonly body: string;
  /** Justification recorded on the approval item for the reviewer. */
  readonly rationale: string;
  readonly riskTags?: readonly string[];
}

/**
 * Port for turning a target into a draft pitch. Returning `null` means
 * "decline to pitch this one" and is recorded as a skip, not an error.
 */
export interface OutreachComposer {
  compose(
    target: PodcastTarget,
    context: OutreachComposeContext,
  ): Promise<ComposedOutreach | null>;
}

// ---------------------------------------------------------------------------
// Cross-run deduplication
// ---------------------------------------------------------------------------

/** One prospect we have already queued outreach for. */
export interface OutreachLedgerEntry {
  readonly prospectId: string;
  /** Normalised (lowercased, trimmed) contact email. */
  readonly contactEmail: string;
  readonly campaignId: string;
  readonly approvalId: string;
  readonly runId: string;
  readonly queuedAt: string;
}

/**
 * Cross-run contact history. In-run deduplication is free; this is what stops
 * the same host being pitched again next week.
 *
 * Agent-specific state, so it lives here rather than in `@timerich/shared`.
 * The in-memory implementation ships for dev and tests; a durable store
 * implements the same three methods.
 */
export interface OutreachLedger {
  findByProspectId(prospectId: string): Promise<OutreachLedgerEntry | undefined>;
  /** `email` is expected to be normalised by the caller. */
  findByEmail(email: string): Promise<OutreachLedgerEntry | undefined>;
  record(entry: OutreachLedgerEntry): Promise<void>;
}
