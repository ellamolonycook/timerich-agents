import type { Agent, AgentContext, AgentRunResult } from '@timerich/shared';
import { notImplementedComposer } from './composer.js';
import { InMemoryOutreachLedger } from './ledger.js';
import {
  PODCAST_OUTREACH_AGENT_ID,
  PODCAST_OUTREACH_EMAIL_CONNECTOR_ID,
  podcastOutreachManifest,
} from './manifest.js';
import type { OutreachComposer, OutreachLedger } from './types.js';
import type { PodcastOutreachInput, PodcastOutreachOutput } from './types.js';
import { runPodcastOutreachWorkflow } from './workflow.js';

export interface PodcastOutreachAgentDeps {
  /** Defaults to a composer that throws; inject a real one when it exists. */
  readonly composer?: OutreachComposer;
  /**
   * Cross-run contact history. Defaults to a fresh in-memory ledger, which
   * de-duplicates within a process but forgets on restart - production must
   * pass a durable implementation.
   */
  readonly ledger?: OutreachLedger;
  /** Outbound connector the intents name. Overridable for staging/test wiring. */
  readonly connectorId?: string;
}

/**
 * Podcast Outreach agent.
 *
 * A thin `Agent` adapter over `runPodcastOutreachWorkflow`: it owns the
 * injected ports and the run identity, and the workflow owns the pipeline.
 * Keeping them apart lets the workflow be tested directly, without an
 * `AgentRunResult` wrapper in the way.
 *
 * Runtime boundary: the last thing this agent touches is
 * `context.outbound.submit`. It cannot send.
 */
export class PodcastOutreachAgent implements Agent<PodcastOutreachInput, PodcastOutreachOutput> {
  readonly manifest = podcastOutreachManifest;

  readonly #composer: OutreachComposer;
  readonly #ledger: OutreachLedger;
  readonly #connectorId: string;

  constructor(deps: PodcastOutreachAgentDeps = {}) {
    this.#composer = deps.composer ?? notImplementedComposer();
    this.#ledger = deps.ledger ?? new InMemoryOutreachLedger();
    this.#connectorId = deps.connectorId ?? PODCAST_OUTREACH_EMAIL_CONNECTOR_ID;
  }

  async run(
    input: PodcastOutreachInput,
    context: AgentContext,
  ): Promise<AgentRunResult<PodcastOutreachOutput>> {
    const runId = context.ids.next('run');
    const startedAt = context.clock.now().toISOString();

    context.logger.info('Podcast outreach run started', {
      agent: PODCAST_OUTREACH_AGENT_ID,
      runId,
      campaignId: input.campaignId,
      inlineTargets: input.targets?.length ?? 0,
      usesProspectSource: input.intake !== undefined,
      maxOutreachPerRun: input.maxOutreachPerRun,
    });

    const { output, approvalIds } = await runPodcastOutreachWorkflow(
      input,
      context,
      { composer: this.#composer, ledger: this.#ledger, connectorId: this.#connectorId },
      runId,
    );

    return {
      agentId: PODCAST_OUTREACH_AGENT_ID,
      runId,
      startedAt,
      finishedAt: context.clock.now().toISOString(),
      approvalIds,
      output,
    };
  }
}
