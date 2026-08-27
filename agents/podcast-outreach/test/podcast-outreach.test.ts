import { describe, expect, it } from 'vitest';
import {
  ApprovalDispatcher,
  ConnectorRegistry,
  FixedClock,
  GuardrailChain,
  InMemoryApprovalStore,
  InMemorySecretProvider,
  MemoryLogSink,
  SequentialIdGenerator,
  TokenBucketRateLimiter,
  ValidationError,
  createAgentRuntime,
  createLogger,
  outboundCompletenessGuardrail,
  rateLimitGuardrail,
  type AgentRuntime,
  type ApprovalToken,
  type DeliveryReceipt,
  type OutboundConnector,
  type OutboundMessage,
} from '@timerich/shared';
import {
  PodcastOutreachAgent,
  notImplementedComposer,
  podcastOutreachManifest,
  type ComposedOutreach,
  type OutreachComposer,
  type PodcastTarget,
} from '../src/index.js';

const START = new Date('2026-01-01T00:00:00.000Z');

class RecordingEmailConnector implements OutboundConnector {
  readonly channel = 'email' as const;
  readonly sent: { message: OutboundMessage; approval: ApprovalToken }[] = [];
  readonly descriptor = {
    id: 'email.primary',
    kind: 'outbound' as const,
    displayName: 'Recording email connector',
    requiredSecrets: [],
  };

  async healthCheck() {
    return { healthy: true, checkedAt: START.toISOString() };
  }

  async send(message: OutboundMessage, approval: ApprovalToken): Promise<DeliveryReceipt> {
    this.sent.push({ message, approval });
    return {
      connectorId: this.descriptor.id,
      channel: this.channel,
      acceptedAt: START.toISOString(),
      dryRun: true,
    };
  }
}

/** Composer stub. Declines any show whose name contains the word skip. */
function stubComposer(): OutreachComposer {
  return {
    async compose(target: PodcastTarget): Promise<ComposedOutreach | null> {
      if (target.showName.toLowerCase().includes('skip')) return null;
      return {
        subject: `Guest idea for ${target.showName}`,
        body: `Hi ${target.hostName ?? 'there'}, a note about ${target.showName}.`,
        rationale: target.relevanceNotes ?? 'Audience overlap with the Time Rich book.',
      };
    },
  };
}

interface Harness extends AgentRuntime {
  readonly connector: RecordingEmailConnector;
  readonly registry: ConnectorRegistry;
  readonly clock: FixedClock;
}

function createHarness(
  guardrails = new GuardrailChain([outboundCompletenessGuardrail()]),
): Harness {
  const clock = new FixedClock(START);
  const connector = new RecordingEmailConnector();
  const registry = new ConnectorRegistry().register(connector);
  const runtime = createAgentRuntime(podcastOutreachManifest.id, {
    clock,
    ids: new SequentialIdGenerator(),
    logger: createLogger({ sink: new MemoryLogSink(), clock }),
    secrets: new InMemorySecretProvider(),
    connectors: registry.asReader(),
    approvalStore: new InMemoryApprovalStore(),
    guardrails,
  });
  return { ...runtime, connector, registry, clock };
}

function target(overrides: Partial<PodcastTarget> = {}): PodcastTarget {
  return {
    id: 't1',
    showName: 'The Time Show',
    hostName: 'Sam',
    contactEmail: 'sam@example.com',
    ...overrides,
  };
}

describe('podcast outreach manifest', () => {
  it('declares the approval boundary and its email channel', () => {
    expect(podcastOutreachManifest.outbound.approvalRequired).toBe(true);
    expect(podcastOutreachManifest.outbound.channels).toEqual(['email']);
    expect(podcastOutreachManifest.connectors[0]?.kind).toBe('outbound');
  });

  it('names required secrets without carrying values', () => {
    const secrets = podcastOutreachManifest.connectors.flatMap((c) => c.requiredSecrets);
    expect(secrets.map((s) => s.name)).toEqual(['EMAIL_PROVIDER_API_KEY']);
    expect(Object.keys(secrets[0] ?? {})).not.toContain('value');
  });
});

describe('PodcastOutreachAgent.run', () => {
  it('queues a draft per eligible target and sends nothing', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: stubComposer() });

    const result = await agent.run(
      {
        campaignId: 'launch-2026',
        maxOutreachPerRun: 10,
        targets: [target(), target({ id: 't2', contactEmail: 'kim@example.com' })],
      },
      h.context,
    );

    expect(result.output.queued).toHaveLength(2);
    expect(result.output.skipped).toHaveLength(0);
    expect(result.output.evaluated).toBe(2);
    expect(h.connector.sent).toHaveLength(0);

    const pending = await h.queue.listPending();
    expect(pending).toHaveLength(2);
    expect(pending[0]?.intent.reason).not.toBe('');
  });

  it('skips targets with no contact email', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: stubComposer() });

    const result = await agent.run(
      {
        campaignId: 'c',
        maxOutreachPerRun: 10,
        targets: [{ id: 'no-email', showName: 'The Time Show', hostName: 'Sam' }],
      },
      h.context,
    );

    expect(result.output.queued).toHaveLength(0);
    expect(result.output.skipped[0]).toEqual({
      targetId: 'no-email',
      reason: 'missing-contact-email',
    });
  });

  it('de-duplicates by id and by email within a run', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: stubComposer() });

    const result = await agent.run(
      {
        campaignId: 'c',
        maxOutreachPerRun: 10,
        targets: [target(), target(), target({ id: 't3', contactEmail: 'SAM@Example.com ' })],
      },
      h.context,
    );

    expect(result.output.queued).toHaveLength(1);
    expect(result.output.skipped.map((s) => s.reason)).toEqual([
      'duplicate-target',
      'duplicate-target',
    ]);
  });

  it('stops at maxOutreachPerRun', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: stubComposer() });

    const result = await agent.run(
      {
        campaignId: 'c',
        maxOutreachPerRun: 1,
        targets: [
          target({ id: 'a', contactEmail: 'a@example.com' }),
          target({ id: 'b', contactEmail: 'b@example.com' }),
        ],
      },
      h.context,
    );

    expect(result.output.queued).toHaveLength(1);
    expect(result.output.skipped[0]?.reason).toBe('run-limit-reached');
  });

  it('records a composer decline as a skip, not a failure', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: stubComposer() });

    const result = await agent.run(
      {
        campaignId: 'c',
        maxOutreachPerRun: 5,
        targets: [target({ showName: 'Please skip me' })],
      },
      h.context,
    );

    expect(result.output.skipped[0]?.reason).toBe('composer-declined');
  });

  it('records a guardrail denial as blocked and queues nothing for approval', async () => {
    const limiter = new TokenBucketRateLimiter({
      capacity: 1,
      refillTokens: 1,
      refillIntervalMs: 60_000,
      clock: new FixedClock(START),
    });
    const h = createHarness(
      new GuardrailChain([outboundCompletenessGuardrail(), rateLimitGuardrail({ limiter })]),
    );
    const agent = new PodcastOutreachAgent({ composer: stubComposer() });

    const result = await agent.run(
      {
        campaignId: 'c',
        maxOutreachPerRun: 5,
        targets: [
          target({ id: 'a', contactEmail: 'a@example.com' }),
          target({ id: 'b', contactEmail: 'b@example.com' }),
        ],
      },
      h.context,
    );

    expect(result.output.queued).toHaveLength(1);
    expect(result.output.skipped[0]).toMatchObject({
      targetId: 'b',
      reason: 'guardrail-blocked',
      detail: 'rate-limit',
    });
    expect(await h.queue.listPending()).toHaveLength(1);
  });

  it('rejects invalid input before touching the outbound gateway', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: stubComposer() });

    await expect(
      agent.run({ campaignId: ' ', maxOutreachPerRun: 5, targets: [] }, h.context),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      agent.run({ campaignId: 'c', maxOutreachPerRun: 0, targets: [] }, h.context),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('fails loudly when no composer has been injected', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: notImplementedComposer() });

    await expect(
      agent.run({ campaignId: 'c', maxOutreachPerRun: 5, targets: [target()] }, h.context),
    ).rejects.toThrow(/not implemented/i);
    expect(h.connector.sent).toHaveLength(0);
  });
});

describe('podcast outreach end to end', () => {
  it('reaches the connector only after a human approves', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: stubComposer() });

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
    expect(h.connector.sent[0]?.approval.decidedBy).toBe('ella');
  });
});
