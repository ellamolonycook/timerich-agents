import {
  GuardrailChain,
  TokenBucketRateLimiter,
  outboundCompletenessGuardrail,
  rateLimitGuardrail,
  type Clock,
  type Guardrail,
  type RateLimiter,
} from '@timerich/shared';

/**
 * Default outreach budget: 25 pitches per hour, burst up to 25.
 *
 * These are starting values, not a considered campaign policy. The real numbers
 * are a `timerich-brain` decision; override them here at the composition root.
 */
export const DEFAULT_OUTREACH_PER_INTERVAL = 25;
export const DEFAULT_OUTREACH_INTERVAL_MS = 60 * 60 * 1000;

export interface PodcastOutreachPolicyOptions {
  readonly maxOutreachPerInterval?: number;
  readonly intervalMs?: number;
  readonly clock?: Clock;
  /** Appended after the built-in guardrails. */
  readonly extraGuardrails?: readonly Guardrail[];
}

export interface PodcastOutreachPolicy {
  readonly guardrails: GuardrailChain;
  readonly rateLimiter: RateLimiter;
}

/**
 * Builds the guardrail chain and the rate limiter together, as one object.
 *
 * This pairing matters. The workflow *peeks* at the limiter before composing a
 * draft, while `rateLimitGuardrail` is what actually *spends* a token at submit
 * time. Both use the agent-id bucket, so they must be backed by the same
 * limiter instance or the pre-check would be meaningless. Returning them
 * together makes it impossible to wire up half of it:
 *
 * ```ts
 * const policy = createPodcastOutreachPolicy();
 * createAgentRuntime(PODCAST_OUTREACH_AGENT_ID, {
 *   guardrails: policy.guardrails,
 *   rateLimiter: policy.rateLimiter,
 *   ...
 * });
 * ```
 *
 * Enforcement stays entirely in the guardrail chain. The peek is an
 * optimisation, never a substitute.
 */
export function createPodcastOutreachPolicy(
  options: PodcastOutreachPolicyOptions = {},
): PodcastOutreachPolicy {
  const capacity = options.maxOutreachPerInterval ?? DEFAULT_OUTREACH_PER_INTERVAL;
  const intervalMs = options.intervalMs ?? DEFAULT_OUTREACH_INTERVAL_MS;

  const rateLimiter = new TokenBucketRateLimiter({
    capacity,
    refillTokens: capacity,
    refillIntervalMs: intervalMs,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  const guardrails = new GuardrailChain([
    outboundCompletenessGuardrail(),
    rateLimitGuardrail({ limiter: rateLimiter }),
    ...(options.extraGuardrails ?? []),
  ]);

  return { guardrails, rateLimiter };
}

/** Guardrail name used by the chain above, for mapping denials to skip reasons. */
export const RATE_LIMIT_GUARDRAIL_NAME = 'rate-limit';
