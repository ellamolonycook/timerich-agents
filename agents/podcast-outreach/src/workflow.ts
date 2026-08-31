import {
  ConfigurationError,
  ValidationError,
  type AgentContext,
  type Connector,
  type OutboundIntent,
} from '@timerich/shared';
import { normalizeProspect } from './intake.js';
import { PODCAST_OUTREACH_AGENT_ID } from './manifest.js';
import { RATE_LIMIT_GUARDRAIL_NAME } from './policy.js';
import { buildSuppressionMatcher, screenProspect } from './screening.js';
import type {
  ComposedOutreach,
  OutreachComposer,
  OutreachLedger,
  PodcastOutreachInput,
  PodcastOutreachOutput,
  PodcastTarget,
  ProspectSourceConnector,
  QueuedOutreach,
  RawProspect,
  SkipReason,
  SkippedTarget,
} from './types.js';

export interface PodcastOutreachWorkflowDeps {
  readonly composer: OutreachComposer;
  readonly ledger: OutreachLedger;
  /** Outbound connector id named on every intent, resolved at dispatch time. */
  readonly connectorId: string;
}

export interface PodcastOutreachWorkflowResult {
  readonly output: PodcastOutreachOutput;
  /** Every approval item created, including ones guardrails blocked. */
  readonly approvalIds: readonly string[];
}

/**
 * The Podcast Outreach workflow.
 *
 *   intake -> screening -> dedupe -> rate check -> compose -> approval queue
 *
 * The pipeline terminates at `context.outbound.submit`. Nothing downstream of
 * that is reachable from here: delivery needs an `ApprovalToken` this code has
 * no way to obtain, and `context.connectors` refuses to resolve outbound
 * connectors at all.
 */
export async function runPodcastOutreachWorkflow(
  input: PodcastOutreachInput,
  context: AgentContext,
  deps: PodcastOutreachWorkflowDeps,
  runId: string,
): Promise<PodcastOutreachWorkflowResult> {
  validateInput(input);

  const logger = context.logger.child({
    agent: PODCAST_OUTREACH_AGENT_ID,
    runId,
    campaignId: input.campaignId,
  });

  const skipped: SkippedTarget[] = [];
  const queued: QueuedOutreach[] = [];
  const approvalIds: string[] = [];

  // --- Stage 1: intake ----------------------------------------------------
  const { targets, received } = await intake(input, context, logger, skipped);
  logger.info('Prospect intake complete', {
    received,
    accepted: targets.length,
    rejected: received - targets.length,
  });

  // --- Stage 2-5: screen, rate check, compose, submit ---------------------
  const isSuppressed = buildSuppressionMatcher(input.suppress ?? []);
  const seenProspectIds = new Set<string>();
  const seenEmails = new Set<string>();

  for (const target of targets) {
    if (queued.length >= input.maxOutreachPerRun) {
      skipped.push({
        targetId: target.id,
        reason: 'run-limit-reached',
        detail: `Run limit of ${input.maxOutreachPerRun} already reached`,
      });
      continue;
    }

    const screening = await screenProspect(target, {
      seenProspectIds,
      seenEmails,
      isSuppressed,
      ledger: deps.ledger,
    });
    if (!screening.eligible) {
      skipped.push({
        targetId: target.id,
        reason: screening.reason,
        ...(screening.detail === undefined ? {} : { detail: screening.detail }),
      });
      logger.debug('Prospect screened out', { prospectId: target.id, reason: screening.reason });
      continue;
    }

    const { contactEmail } = screening;
    seenProspectIds.add(target.id);
    seenEmails.add(contactEmail);

    // Cheap pre-check so we do not pay for composition on a pitch the guardrail
    // chain is about to refuse. `peek` spends nothing; the rate-limit guardrail
    // remains the single point of enforcement at submit time.
    const budget = await context.rateLimiter.peek(PODCAST_OUTREACH_AGENT_ID);
    if (!budget.allowed) {
      skipped.push({
        targetId: target.id,
        reason: 'rate-limited',
        detail: `Retry in ${budget.retryAfterMs}ms`,
      });
      continue;
    }

    const composed = await deps.composer.compose(target, {
      campaignId: input.campaignId,
      agentId: PODCAST_OUTREACH_AGENT_ID,
      runId,
    });
    if (composed === null) {
      skipped.push({ targetId: target.id, reason: 'composer-declined' });
      continue;
    }

    const intent = buildIntent(input, target, composed, deps.connectorId, runId, contactEmail);
    const submission = await context.outbound.submit(intent);
    approvalIds.push(submission.approvalId);

    if (submission.status === 'pending-approval') {
      queued.push({ targetId: target.id, approvalId: submission.approvalId, channel: 'email' });
      await deps.ledger.record({
        prospectId: target.id,
        contactEmail,
        campaignId: input.campaignId,
        approvalId: submission.approvalId,
        runId,
        queuedAt: context.clock.now().toISOString(),
      });
      logger.debug('Outreach queued for approval', {
        prospectId: target.id,
        approvalId: submission.approvalId,
      });
      continue;
    }

    // Blocked by guardrails. The item is stored as `blocked` for the reviewer,
    // and is NOT written to the ledger - nothing was queued, so the prospect
    // stays eligible for a later run.
    const guardrailNames = submission.denials.map((denial) => denial.guardrail);
    skipped.push({
      targetId: target.id,
      reason: guardrailNames.includes(RATE_LIMIT_GUARDRAIL_NAME)
        ? 'rate-limited'
        : 'guardrail-blocked',
      detail: guardrailNames.join(', '),
    });
    logger.warn('Outreach blocked by guardrails', {
      prospectId: target.id,
      approvalId: submission.approvalId,
      denials: guardrailNames,
    });
  }

  const output: PodcastOutreachOutput = {
    campaignId: input.campaignId,
    intake: {
      received,
      accepted: targets.length,
      rejected: received - targets.length,
    },
    evaluated: targets.length,
    queued,
    skipped,
    skippedByReason: countByReason(skipped),
  };

  logger.info('Podcast outreach run finished', {
    queued: queued.length,
    skipped: skipped.length,
    skippedByReason: output.skippedByReason,
  });

  return { output, approvalIds };
}

// ---------------------------------------------------------------------------
// Stage 1: intake
// ---------------------------------------------------------------------------

interface IntakeOutcome {
  readonly targets: readonly PodcastTarget[];
  /** Records seen from both sources, before normalisation. */
  readonly received: number;
}

async function intake(
  input: PodcastOutreachInput,
  context: AgentContext,
  logger: AgentContext['logger'],
  skipped: SkippedTarget[],
): Promise<IntakeOutcome> {
  const inline = input.targets ?? [];
  const targets: PodcastTarget[] = [...inline];
  let received = inline.length;

  if (input.intake !== undefined) {
    const source = resolveProspectSource(context, input.intake.connectorId);
    const records = await source.fetch(input.intake.query);
    received += records.length;

    records.forEach((raw, index) => {
      const normalized = normalizeProspect(raw);
      if (normalized.ok) {
        targets.push(normalized.target);
        return;
      }
      skipped.push({
        targetId: describeRawProspect(raw, index),
        reason: 'intake-invalid',
        detail: normalized.reason,
      });
      // The raw record goes through the shared logger, so any secret-shaped
      // field a provider attached is redacted before it reaches a sink.
      logger.debug('Prospect record rejected at intake', {
        reason: normalized.reason,
        record: raw,
      });
    });
  }

  return { targets, received };
}

/**
 * Resolves the prospect source through the agent's connector reader.
 *
 * The reader refuses outbound connectors outright, so this can only ever return
 * something read-only. The kind check makes the failure legible rather than
 * letting a mis-registered connector fail later with a missing `fetch`.
 */
function resolveProspectSource(
  context: AgentContext,
  connectorId: string,
): ProspectSourceConnector {
  const connector: Connector = context.connectors.require(connectorId);
  if (connector.descriptor.kind !== 'data-source') {
    throw new ConfigurationError(
      `Connector '${connectorId}' is not a prospect source; expected kind 'data-source'`,
      { connectorId, kind: connector.descriptor.kind },
    );
  }
  if (typeof (connector as Partial<ProspectSourceConnector>).fetch !== 'function') {
    throw new ConfigurationError(
      `Connector '${connectorId}' does not implement ProspectSourceConnector.fetch`,
      { connectorId },
    );
  }
  return connector as ProspectSourceConnector;
}

/** Best-effort label for a record that failed to normalise. */
function describeRawProspect(raw: RawProspect, index: number): string {
  const id = raw['id'];
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : `intake[${index}]`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildIntent(
  input: PodcastOutreachInput,
  target: PodcastTarget,
  composed: ComposedOutreach,
  connectorId: string,
  runId: string,
  contactEmail: string,
): OutboundIntent {
  return {
    agentId: PODCAST_OUTREACH_AGENT_ID,
    connectorId,
    channel: 'email',
    runId,
    reason: composed.rationale,
    riskTags: composed.riskTags ?? ['cold-contact', 'podcast-outreach'],
    message: {
      channel: 'email',
      to: {
        id: target.id,
        address: contactEmail,
        displayName: target.hostName ?? target.showName,
      },
      subject: composed.subject,
      body: composed.body,
      metadata: {
        campaignId: input.campaignId,
        showName: target.showName,
        ...(target.website === undefined ? {} : { website: target.website }),
        ...(target.relevanceNotes === undefined ? {} : { relevanceNotes: target.relevanceNotes }),
      },
    },
  };
}

function countByReason(
  skipped: readonly SkippedTarget[],
): Readonly<Partial<Record<SkipReason, number>>> {
  const counts: Partial<Record<SkipReason, number>> = {};
  for (const entry of skipped) {
    counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
  }
  return counts;
}

function validateInput(input: PodcastOutreachInput): void {
  if (input.campaignId.trim() === '') {
    throw new ValidationError('campaignId is required');
  }
  if (!Number.isInteger(input.maxOutreachPerRun) || input.maxOutreachPerRun < 1) {
    throw new ValidationError('maxOutreachPerRun must be a positive integer', {
      received: input.maxOutreachPerRun,
    });
  }
  if (input.targets === undefined && input.intake === undefined) {
    throw new ValidationError('Provide targets, an intake request, or both');
  }
}
