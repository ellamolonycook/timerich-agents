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
  type GuardrailChain,
  type OutboundConnector,
  type OutboundIntent,
  type OutboundMessage,
} from '../src/index.js';

export const START = new Date('2026-01-01T00:00:00.000Z');

/**
 * Outbound connector test double. It records every send along with the token
 * it was handed, which lets tests assert that a real approval preceded it.
 */
export class RecordingOutboundConnector implements OutboundConnector {
  readonly channel = 'email' as const;
  readonly sent: { message: OutboundMessage; approval: ApprovalToken }[] = [];
  failWith: Error | undefined;

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
    if (this.failWith !== undefined) throw this.failWith;
    this.sent.push({ message, approval });
    return {
      connectorId: this.descriptor.id,
      channel: this.channel,
      acceptedAt: START.toISOString(),
      providerMessageId: `prov_${this.sent.length}`,
      dryRun: true,
    };
  }
}

export interface Harness extends AgentRuntime {
  readonly clock: FixedClock;
  readonly sink: MemoryLogSink;
  readonly connector: RecordingOutboundConnector;
  readonly registry: ConnectorRegistry;
}

export function createHarness(guardrails?: GuardrailChain): Harness {
  const clock = new FixedClock(START);
  const sink = new MemoryLogSink();
  const logger = createLogger({ sink, level: 'debug', clock });
  const connector = new RecordingOutboundConnector();
  const registry = new ConnectorRegistry().register(connector as Connector);

  const runtime = createAgentRuntime('test-agent', {
    logger,
    clock,
    ids: new SequentialIdGenerator(),
    secrets: new InMemorySecretProvider(),
    connectors: registry.asReader(),
    approvalStore: new InMemoryApprovalStore(),
    ...(guardrails === undefined ? {} : { guardrails }),
  });

  return { ...runtime, clock, sink, connector, registry };
}

export function anIntent(overrides: Partial<OutboundIntent> = {}): OutboundIntent {
  return {
    agentId: 'test-agent',
    connectorId: 'email.primary',
    channel: 'email',
    reason: 'Relevant show for the Time Rich book launch.',
    message: {
      channel: 'email',
      to: { address: 'host@example.com', displayName: 'Host' },
      subject: 'Guest pitch',
      body: 'Would you consider Ella as a guest?',
    },
    ...overrides,
  };
}
