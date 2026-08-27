import type { OutboundChannel } from '@timerich/shared';

/** A podcast we are considering pitching. Sourced upstream, not by this agent. */
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

export interface PodcastOutreachInput {
  readonly campaignId: string;
  readonly targets: readonly PodcastTarget[];
  /** Hard ceiling on approval items this run may create. */
  readonly maxOutreachPerRun: number;
}

export type SkipReason =
  | 'missing-contact-email'
  | 'duplicate-target'
  | 'run-limit-reached'
  | 'composer-declined'
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

export interface PodcastOutreachOutput {
  readonly campaignId: string;
  /** Targets the agent looked at, including skipped ones. */
  readonly evaluated: number;
  /** Drafts now waiting on a human decision. Nothing has been sent. */
  readonly queued: readonly QueuedOutreach[];
  readonly skipped: readonly SkippedTarget[];
}

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
 *
 * The real implementation is out of scope for the scaffold.
 */
export interface OutreachComposer {
  compose(
    target: PodcastTarget,
    context: OutreachComposeContext,
  ): Promise<ComposedOutreach | null>;
}
