import { describe, expect, it } from 'vitest';
import {
  ApprovalDispatcher,
  ApprovalRequiredError,
  ConfigurationError,
  NotImplementedError,
} from '@timerich/shared';
import {
  PODCAST_OUTREACH_EMAIL_CONNECTOR_ID,
  PODCAST_OUTREACH_PROSPECT_CONNECTOR_ID,
  PodcastOutreachAgent,
  notImplementedComposer,
  podcastOutreachManifest,
  templateOutreachComposer,
  type OutreachComposeContext,
  type PodcastTarget,
} from '../src/index.js';
import { createHarness, realTemplateComposer, stubComposer, target } from './harness.js';

const composeContext: OutreachComposeContext = {
  campaignId: 'c',
  agentId: 'podcast-outreach',
  runId: 'run_1',
};

describe('manifest', () => {
  it('declares the approval boundary and its email channel', () => {
    expect(podcastOutreachManifest.outbound.approvalRequired).toBe(true);
    expect(podcastOutreachManifest.outbound.channels).toEqual(['email']);
  });

  it('declares one outbound connector and one read-only prospect source', () => {
    const byId = new Map(
      podcastOutreachManifest.connectors.map((connector) => [connector.connectorId, connector]),
    );

    expect(byId.get(PODCAST_OUTREACH_EMAIL_CONNECTOR_ID)?.kind).toBe('outbound');
    expect(byId.get(PODCAST_OUTREACH_PROSPECT_CONNECTOR_ID)?.kind).toBe('data-source');
    expect(podcastOutreachManifest.connectors).toHaveLength(2);
  });

  it('names required secrets without carrying values', () => {
    const secrets = podcastOutreachManifest.connectors.flatMap(
      (connector) => connector.requiredSecrets,
    );

    expect(secrets.map((secret) => secret.name).sort()).toEqual([
      'EMAIL_PROVIDER_API_KEY',
      'PODCAST_PROSPECT_SOURCE_API_KEY',
    ]);
    for (const secret of secrets) {
      expect(Object.keys(secret)).not.toContain('value');
    }
  });

  it('states the boundaries the workflow is built to respect', () => {
    const boundaries = podcastOutreachManifest.boundaries.join(' ');
    expect(boundaries).toContain('Never sends');
    expect(boundaries).toContain('timerich-brain');
  });
});

describe('templateOutreachComposer', () => {
  it('composes from the template and falls back to relevance notes for the rationale', async () => {
    const composer = templateOutreachComposer({
      subject: (candidate) => `Guest idea for ${candidate.showName}`,
      body: () => 'A short pitch.',
    });

    const composed = await composer.compose(target(), composeContext);

    expect(composed).toEqual({
      subject: 'Guest idea for The Time Show',
      body: 'A short pitch.',
      rationale: 'Covers time management for founders.',
    });
  });

  it('declines rather than emitting a draft a reviewer could not act on', async () => {
    const blankBody = templateOutreachComposer({
      subject: () => 'Subject',
      body: () => '   ',
    });
    const noRationale = templateOutreachComposer({
      subject: () => 'Subject',
      body: () => 'Body',
    });
    const bare: PodcastTarget = { id: 'x', showName: 'No Notes', contactEmail: 'x@example.com' };

    await expect(blankBody.compose(target(), composeContext)).resolves.toBeNull();
    await expect(noRationale.compose(bare, composeContext)).resolves.toBeNull();
  });

  it('passes risk tags through to the approval item', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({
      composer: realTemplateComposer(),
      ledger: h.ledger,
    });

    await agent.run({ campaignId: 'c', maxOutreachPerRun: 5, targets: [target()] }, h.context);

    const [item] = await h.queue.listPending();
    expect(item?.intent.riskTags).toEqual(['cold-contact', 'podcast-outreach']);
  });
});

describe('composer default', () => {
  it('fails loudly when no composer has been injected', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ ledger: h.ledger });

    await expect(
      agent.run({ campaignId: 'c', maxOutreachPerRun: 5, targets: [target()] }, h.context),
    ).rejects.toBeInstanceOf(NotImplementedError);
    expect(h.connector.sent).toHaveLength(0);
  });

  it('names the target it could not compose for', async () => {
    await expect(
      notImplementedComposer().compose(target(), composeContext),
    ).rejects.toThrow(/not implemented/i);
  });
});

describe('safety boundary', () => {
  it('never sends during a run, however many drafts it queues', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });

    await agent.run(
      {
        campaignId: 'c',
        maxOutreachPerRun: 10,
        targets: [
          target({ id: 'a', contactEmail: 'a@example.com' }),
          target({ id: 'b', contactEmail: 'b@example.com' }),
          target({ id: 'c', contactEmail: 'c@example.com' }),
        ],
      },
      h.context,
    );

    expect(h.connector.sent).toHaveLength(0);
    expect(await h.queue.listPending()).toHaveLength(3);
  });

  it('does not let the agent resolve the outbound connector it names', () => {
    const h = createHarness();

    expect(() => h.context.connectors.require(PODCAST_OUTREACH_EMAIL_CONNECTOR_ID)).toThrow(
      ConfigurationError,
    );
    // The read-only prospect source is still reachable.
    expect(h.context.connectors.require(PODCAST_OUTREACH_PROSPECT_CONNECTOR_ID)).toBe(
      h.prospectSource,
    );
  });

  it('exposes submit but no send on the outbound gateway', () => {
    const h = createHarness();
    const gateway = h.context.outbound as unknown as Record<string, unknown>;

    expect(typeof gateway['submit']).toBe('function');
    expect(gateway['send']).toBeUndefined();
  });

  it('refuses to dispatch a queued draft before a human approves it', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });
    const result = await agent.run(
      { campaignId: 'c', maxOutreachPerRun: 5, targets: [target()] },
      h.context,
    );
    const approvalId = result.output.queued[0]?.approvalId ?? '';

    const dispatcher = new ApprovalDispatcher({
      queue: h.queue,
      connectors: h.registry.asReader(),
      logger: h.context.logger,
    });

    await expect(dispatcher.dispatch(approvalId)).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(h.connector.sent).toHaveLength(0);
  });

  it('reaches the connector only after a human approves, carrying that decision', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });

    const result = await agent.run(
      { campaignId: 'launch-2026', maxOutreachPerRun: 5, targets: [target()] },
      h.context,
    );
    const approvalId = result.output.queued[0]?.approvalId ?? '';
    expect(h.connector.sent).toHaveLength(0);

    await h.queue.approve(approvalId, { decidedBy: 'ella', note: 'Good fit' });
    const dispatch = await new ApprovalDispatcher({
      queue: h.queue,
      connectors: h.registry.asReader(),
      logger: h.context.logger,
    }).dispatch(approvalId);

    expect(dispatch.status).toBe('dispatched');
    expect(h.connector.sent).toHaveLength(1);
    expect(h.connector.sent[0]?.message.subject).toBe('Guest idea for The Time Show');
    expect(h.connector.sent[0]?.approval.approvalId).toBe(approvalId);
    expect(h.connector.sent[0]?.approval.decidedBy).toBe('ella');
  });

  it('does not send a draft the reviewer rejected', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });
    const result = await agent.run(
      { campaignId: 'c', maxOutreachPerRun: 5, targets: [target()] },
      h.context,
    );
    const approvalId = result.output.queued[0]?.approvalId ?? '';

    await h.queue.reject(approvalId, { decidedBy: 'ella', note: 'Off-brand' });

    await expect(
      new ApprovalDispatcher({
        queue: h.queue,
        connectors: h.registry.asReader(),
        logger: h.context.logger,
      }).dispatch(approvalId),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(h.connector.sent).toHaveLength(0);
  });
});

describe('run result envelope', () => {
  it('reports run identity and every approval item it created', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });

    const result = await agent.run(
      { campaignId: 'launch-2026', maxOutreachPerRun: 5, targets: [target()] },
      h.context,
    );

    expect(result.agentId).toBe('podcast-outreach');
    expect(result.runId).toMatch(/^run_/);
    expect(result.approvalIds).toEqual([result.output.queued[0]?.approvalId]);
    expect(result.output.campaignId).toBe('launch-2026');
    expect(Date.parse(result.finishedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
  });
});
