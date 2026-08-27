import {
  ValidationError,
  type Agent,
  type AgentContext,
  type AgentRunResult,
  type OutboundIntent,
} from '@timerich/shared';
import { notImplementedComposer } from './composer.js';
import {
  PODCAST_OUTREACH_AGENT_ID,
  PODCAST_OUTREACH_EMAIL_CONNECTOR_ID,
  podcastOutreachManifest,
} from './manifest.js';
import type {
  ComposedOutreach,
  OutreachComposer,
  PodcastOutreachInput,
  PodcastOutreachOutput,
  PodcastTarget,
  QueuedOutreach,
  SkippedTarget,
} from './types.js';

export interface PodcastOutreachAgentDeps {
  /** Defaults to a composer that throws; inject a real one when it exists. */
  readonly composer?: OutreachComposer;
  /** Connector the intents name. Overridable for staging/test wiring. */
  readonly connectorId?: string;
}

/**
 * Podcast Outreach agent.
 *
 * Runtime boundary: the agent screens targets, asks the composer for a draft,
 * and hands each draft to `context.outbound.submit`. That is the last thing it
 * touches. Delivery requires an `ApprovalToken`, which only the approval queue
 * mints and which this agent has no way to obtain.
 */
export class PodcastOutreachAgent implements Agent<PodcastOutreachInput, PodcastOutreachOutput> {
  readonly manifest = podcastOutreachManifest;

  readonly #composer: OutreachComposer;
  readonly #connectorId: string;

  constructor(deps: PodcastOutreachAgentDeps = {}) {
    this.#composer = deps.composer ?? notImplementedComposer();
    this.#connectorId = deps.connectorId ?? PODCAST_OUTREACH_EMAIL_CONNECTOR_ID;
  }

  async run(
    input: PodcastOutreachInput,
    context: AgentContext,
  ): Promise<AgentRunResult<PodcastOutreachOutput>> {
    validate(input);

    const runId = context.ids.next('run');
    const startedAt = context.clock.now().toISOString();
    const logger = context.logger.child({ agent: PODCAST_OUTREACH_AGENT_ID, runId });
    logger.info('Podcast outreach run started', {
      campaignId: input.campaignId,
      targets: input.targets.length,
      maxOutreachPerRun: input.maxOutreachPerRun,
    });

    const queued: QueuedOutreach[] = [];
    const skipped: SkippedTarget[] = [];
    const approvalIds: string[] = [];
    const seenTargetIds = new Set<string>();
    const seenEmails = new Set<string>();

    for (const target of input.targets) {
      if (queued.length >= input.maxOutreachPerRun) {
        skipped.push({
          targetId: target.id,
          reason: 'run-limit-reached',
          detail: `Run limit of ${input.maxOutreachPerRun} already reached`,
        });
        continue;
      }

      const email = target.contactEmail?.trim().toLowerCase() ?? '';
      if (email === '') {
        skipped.push({ targetId: target.id, reason: 'missing-contact-email' });
        continue;
      }
      if (seenTargetIds.has(target.id) || seenEmails.has(email)) {
        skipped.push({ targetId: target.id, reason: 'duplicate-target' });
        continue;
      }
      seenTargetIds.add(target.id);
      seenEmails.add(email);

      const composed = await this.#composer.compose(target, {
        campaignId: input.campaignId,
        agentId: PODCAST_OUTREACH_AGENT_ID,
        runId,
      });
      if (composed === null) {
        skipped.push({ targetId: target.id, reason: 'composer-declined' });
        continue;
      }

      const intent = this.#buildIntent(input, target, composed, runId, email);
      const submission = await context.outbound.submit(intent);
      approvalIds.push(submission.approvalId);

      if (submission.status === 'pending-approval') {
        queued.push({ targetId: target.id, approvalId: submission.approvalId, channel: 'email' });
      } else {
        skipped.push({
          targetId: target.id,
          reason: 'guardrail-blocked',
          detail: submission.denials.map((denial) => denial.guardrail).join(', '),
        });
      }
    }

    const finishedAt = context.clock.now().toISOString();
    logger.info('Podcast outreach run finished', {
      campaignId: input.campaignId,
      queued: queued.length,
      skipped: skipped.length,
    });

    return {
      agentId: PODCAST_OUTREACH_AGENT_ID,
      runId,
      startedAt,
      finishedAt,
      approvalIds,
      output: {
        campaignId: input.campaignId,
        evaluated: input.targets.length,
        queued,
        skipped,
      },
    };
  }

  #buildIntent(
    input: PodcastOutreachInput,
    target: PodcastTarget,
    composed: ComposedOutreach,
    runId: string,
    email: string,
  ): OutboundIntent {
    const displayName = target.hostName ?? target.showName;
    return {
      agentId: PODCAST_OUTREACH_AGENT_ID,
      connectorId: this.#connectorId,
      channel: 'email',
      runId,
      reason: composed.rationale,
      riskTags: composed.riskTags ?? ['cold-contact', 'podcast-outreach'],
      message: {
        channel: 'email',
        to: { id: target.id, address: email, displayName },
        subject: composed.subject,
        body: composed.body,
        metadata: {
          campaignId: input.campaignId,
          showName: target.showName,
          ...(target.website === undefined ? {} : { website: target.website }),
          ...(target.relevanceNotes === undefined
            ? {}
            : { relevanceNotes: target.relevanceNotes }),
        },
      },
    };
  }
}

function validate(input: PodcastOutreachInput): void {
  if (input.campaignId.trim() === '') {
    throw new ValidationError('campaignId is required');
  }
  if (!Number.isInteger(input.maxOutreachPerRun) || input.maxOutreachPerRun < 1) {
    throw new ValidationError('maxOutreachPerRun must be a positive integer', {
      received: input.maxOutreachPerRun,
    });
  }
}
