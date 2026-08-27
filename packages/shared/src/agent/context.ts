import { ApprovalGatedOutboundGateway } from '../approval-queue/gateway.js';
import { ApprovalQueue } from '../approval-queue/queue.js';
import type { ApprovalStore } from '../approval-queue/types.js';
import type { RuntimeConfig } from '../auth/config.js';
import { DEFAULT_RUNTIME_CONFIG } from '../auth/config.js';
import type { SecretProvider } from '../auth/types.js';
import type { ConnectorReader } from '../connectors/registry.js';
import { ConnectorRegistry, restrictOutboundAccess } from '../connectors/registry.js';
import type { Clock } from '../core/clock.js';
import { systemClock } from '../core/clock.js';
import type { IdGenerator } from '../core/ids.js';
import { uuidIdGenerator } from '../core/ids.js';
import { GuardrailChain } from '../guardrails/chain.js';
import type { RateLimiter } from '../guardrails/rate-limit.js';
import { NoopRateLimiter } from '../guardrails/rate-limit.js';
import { createLogger } from '../logging/logger.js';
import type { Logger } from '../logging/types.js';
import type { AgentContext } from './types.js';

export interface AgentRuntimeDeps {
  readonly config?: RuntimeConfig;
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly secrets: SecretProvider;
  readonly connectors?: ConnectorReader;
  readonly guardrails?: GuardrailChain;
  readonly rateLimiter?: RateLimiter;
  readonly approvalStore: ApprovalStore;
}

export interface AgentRuntime {
  readonly context: AgentContext;
  readonly queue: ApprovalQueue;
}

/**
 * Composition root helper. Builds the approval queue and the approval-gated
 * gateway, then hands the agent a context that can queue but cannot send.
 *
 * The queue is returned separately: operator tooling needs it, agents must not
 * have it.
 */
export function createAgentRuntime(agentId: string, deps: AgentRuntimeDeps): AgentRuntime {
  const config = deps.config ?? DEFAULT_RUNTIME_CONFIG;
  const clock = deps.clock ?? systemClock;
  const ids = deps.ids ?? uuidIdGenerator;
  const baseLogger =
    deps.logger ?? createLogger({ level: config.logLevel, clock, base: { agentId } });
  const logger = baseLogger.child({ agentId });
  const connectors = restrictOutboundAccess(deps.connectors ?? new ConnectorRegistry().asReader());
  const guardrails = deps.guardrails ?? new GuardrailChain();
  const rateLimiter = deps.rateLimiter ?? new NoopRateLimiter();

  const queue = new ApprovalQueue({
    store: deps.approvalStore,
    clock,
    ids,
    logger,
    ttlMinutes: config.approvalTtlMinutes,
  });

  const outbound = new ApprovalGatedOutboundGateway({ queue, guardrails, clock });

  return {
    queue,
    context: {
      config,
      logger,
      clock,
      ids,
      secrets: deps.secrets,
      connectors,
      guardrails,
      rateLimiter,
      outbound,
    },
  };
}
