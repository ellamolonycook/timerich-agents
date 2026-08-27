import type { OutboundGateway } from '../approval-queue/gateway.js';
import type { RuntimeConfig } from '../auth/config.js';
import type { SecretProvider, SecretRef } from '../auth/types.js';
import type { AgentConnectorReader } from '../connectors/registry.js';
import type { ConnectorKind, OutboundChannel } from '../connectors/types.js';
import type { Clock } from '../core/clock.js';
import type { IdGenerator } from '../core/ids.js';
import type { GuardrailChain } from '../guardrails/chain.js';
import type { RateLimiter } from '../guardrails/rate-limit.js';
import type { Logger } from '../logging/types.js';

export interface ConnectorRequirement {
  readonly connectorId: string;
  readonly kind: ConnectorKind;
  readonly purpose: string;
  readonly requiredSecrets: readonly SecretRef[];
}

/**
 * Declarative description of an agent: what it is allowed to touch and what it
 * must never do. `approvalRequired` is typed as the literal `true`, so no agent
 * can declare itself exempt from the approval boundary.
 */
export interface AgentManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly responsibilities: readonly string[];
  /** Explicit statements of what this agent does NOT do. */
  readonly boundaries: readonly string[];
  readonly connectors: readonly ConnectorRequirement[];
  readonly outbound: {
    readonly channels: readonly OutboundChannel[];
    readonly approvalRequired: true;
  };
}

/**
 * Everything an agent may use at runtime. All dependencies are explicit and
 * injectable, so a run can be exercised end to end with fakes.
 *
 * Note what is absent: no way to send. `outbound` only queues for approval, and
 * `connectors` cannot resolve an outbound connector.
 */
export interface AgentContext {
  readonly config: RuntimeConfig;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly secrets: SecretProvider;
  /** Outbound connectors are deliberately not reachable through this. */
  readonly connectors: AgentConnectorReader;
  readonly guardrails: GuardrailChain;
  readonly rateLimiter: RateLimiter;
  readonly outbound: OutboundGateway;
}

export interface AgentRunResult<TOutput> {
  readonly agentId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly output: TOutput;
  /** Approval item ids created during the run. */
  readonly approvalIds: readonly string[];
}

export interface Agent<TInput, TOutput> {
  readonly manifest: AgentManifest;
  run(input: TInput, context: AgentContext): Promise<AgentRunResult<TOutput>>;
}
