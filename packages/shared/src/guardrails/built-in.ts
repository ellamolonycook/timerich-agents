import type { RateLimiter } from './rate-limit.js';
import type { Guardrail, GuardrailInput, GuardrailResult } from './types.js';
import { allow, deny } from './types.js';

export interface RateLimitGuardrailOptions {
  readonly limiter: RateLimiter;
  /** Derives the bucket key. Defaults to one bucket per agent. */
  readonly key?: (input: GuardrailInput) => string;
  readonly name?: string;
}

/**
 * Spends a rate-limit token when the action is evaluated. Because the chain
 * runs before an item is queued, a rate-limited item is never queued at all.
 */
export function rateLimitGuardrail(options: RateLimitGuardrailOptions): Guardrail {
  const key = options.key ?? ((input: GuardrailInput) => input.agentId);
  const name = options.name ?? 'rate-limit';
  return {
    name,
    async evaluate(input): Promise<GuardrailResult> {
      const decision = await options.limiter.consume(key(input));
      if (decision.allowed) {
        return allow(name, { remaining: decision.remaining, limit: decision.limit });
      }
      return deny(name, 'Rate limit exceeded', {
        retryAfterMs: decision.retryAfterMs,
        limit: decision.limit,
      });
    },
  };
}

/**
 * Rejects outbound intents missing the fields a reviewer needs: a recipient
 * address, a non-empty body, and a stated reason for the send.
 */
export function outboundCompletenessGuardrail(): Guardrail {
  const name = 'outbound-completeness';
  return {
    name,
    evaluate(input): GuardrailResult {
      if (input.action !== 'outbound-send') return allow(name);
      const intent = input.intent;
      if (intent === undefined) {
        return deny(name, 'Outbound action submitted without an intent');
      }
      if (intent.message.to.address.trim() === '') {
        return deny(name, 'Outbound message has no recipient address');
      }
      if (intent.message.body.trim() === '') {
        return deny(name, 'Outbound message has an empty body');
      }
      if (intent.reason.trim() === '') {
        return deny(name, 'Outbound intent has no stated reason for the reviewer');
      }
      return allow(name);
    },
  };
}
