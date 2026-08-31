import {
  ConnectorRegistry,
  FixedClock,
  InMemoryApprovalStore,
  InMemorySecretProvider,
  MemoryLogSink,
  SequentialIdGenerator,
  createAgentRuntime,
  createLogger,
  type AgentRuntime,
  type ApprovalToken,
  type Connector,
  type DeliveryReceipt,
  type OutboundConnector,
  type OutboundMessage,
} from '@timerich/shared';
import {
  InMemoryOutreachLedger,
  InMemoryProspectSource,
  PODCAST_OUTREACH_AGENT_ID,
  PODCAST_OUTREACH_EMAIL_CONNECTOR_ID,
  createPodcastOutreachPolicy,
  templateOutreachComposer,
  type ComposedOutreach,
  type OutreachComposer,
  type PodcastTarget,
  type RawProspect,
} from '../src/index.js';

export const START = new Date('2026-01-01T00:00:00.000Z');

/**
 * Outbound connector test double. It records the token it was handed, so tests
 * can assert a real approval preceded every send.
 */
export class RecordingEmailConnector implements OutboundConnector {
  readonly channel = 'email' as const;
  readonly sent: { message: OutboundMessage; approval: ApprovalToken }[] = [];

  readonly descriptor = {
    id: PODCAST_OUTREACH_EMAIL_CONNECTOR_ID,
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

/** Composer stub. Declines any show whose name contains the word "skip". */
export function stubComposer(): OutreachComposer {
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

/** Template-driven composer, used to exercise the real composer adapter. */
export function realTemplateComposer(): OutreachComposer {
  return templateOutreachComposer({
    subject: (target) => `Guest idea for ${target.showName}`,
    body: (target) => `Hi ${target.hostName ?? 'there'}, a note about ${target.showName}.`,
    rationale: (target) => target.relevanceNotes ?? 'Audience overlap with the Time Rich book.',
    riskTags: ['cold-contact', 'podcast-outreach'],
  });
}

export interface HarnessOptions {
  /** Outreach budget per interval. Defaults to a large, non-interfering value. */
  readonly maxOutreachPerInterval?: number;
  readonly prospects?: readonly RawProspect[];
  readonly ledger?: InMemoryOutreachLedger;
  /** Extra connectors to register, for mis-configuration tests. */
  readonly extraConnectors?: readonly Connector[];
}

export interface Harness extends AgentRuntime {
  readonly connector: RecordingEmailConnector;
  readonly prospectSource: InMemoryProspectSource;
  readonly registry: ConnectorRegistry;
  readonly ledger: InMemoryOutreachLedger;
  readonly clock: FixedClock;
  readonly sink: MemoryLogSink;
}

/**
 * Wires the agent exactly the way a composition root would: one policy object
 * supplying both the guardrail chain and the rate limiter, a restricted
 * connector reader, and in-memory stores.
 */
export function createHarness(options: HarnessOptions = {}): Harness {
  const clock = new FixedClock(START);
  const sink = new MemoryLogSink();
  const connector = new RecordingEmailConnector();
  const prospectSource = new InMemoryProspectSource(options.prospects ?? []);
  const registry = new ConnectorRegistry()
    .register(connector as Connector)
    .register(prospectSource as Connector);
  for (const extra of options.extraConnectors ?? []) registry.register(extra);
  const ledger = options.ledger ?? new InMemoryOutreachLedger();

  const policy = createPodcastOutreachPolicy({
    maxOutreachPerInterval: options.maxOutreachPerInterval ?? 1000,
    clock,
  });

  const runtime = createAgentRuntime(PODCAST_OUTREACH_AGENT_ID, {
    clock,
    ids: new SequentialIdGenerator(),
    logger: createLogger({ sink, level: 'debug', clock }),
    secrets: new InMemorySecretProvider(),
    connectors: registry.asReader(),
    approvalStore: new InMemoryApprovalStore(),
    guardrails: policy.guardrails,
    rateLimiter: policy.rateLimiter,
  });

  return { ...runtime, connector, prospectSource, registry, ledger, clock, sink };
}

export function target(overrides: Partial<PodcastTarget> = {}): PodcastTarget {
  return {
    id: 't1',
    showName: 'The Time Show',
    hostName: 'Sam',
    contactEmail: 'sam@example.com',
    relevanceNotes: 'Covers time management for founders.',
    ...overrides,
  };
}
