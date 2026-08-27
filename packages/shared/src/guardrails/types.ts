import type { OutboundIntent } from '../approval-queue/types.js';

export type GuardrailDecision = 'allow' | 'deny';

export type GuardrailAction = 'outbound-send' | 'data-read' | 'enrichment';

export interface GuardrailInput {
  readonly agentId: string;
  readonly action: GuardrailAction;
  readonly now: Date;
  /** Present when the action is an outbound send. */
  readonly intent?: OutboundIntent;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface GuardrailResult {
  readonly guardrail: string;
  readonly decision: GuardrailDecision;
  readonly reason?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * A single policy check. Guardrails may read state but must not perform
 * external side effects, so a chain is cheap to evaluate and easy to test.
 */
export interface Guardrail {
  readonly name: string;
  evaluate(input: GuardrailInput): Promise<GuardrailResult> | GuardrailResult;
}

export interface GuardrailEvaluation {
  readonly allowed: boolean;
  readonly evaluatedAt: string;
  readonly results: readonly GuardrailResult[];
  readonly denials: readonly GuardrailResult[];
}

export function allow(
  guardrail: string,
  details?: Readonly<Record<string, unknown>>,
): GuardrailResult {
  return details === undefined
    ? { guardrail, decision: 'allow' }
    : { guardrail, decision: 'allow', details };
}

export function deny(
  guardrail: string,
  reason: string,
  details?: Readonly<Record<string, unknown>>,
): GuardrailResult {
  return details === undefined
    ? { guardrail, decision: 'deny', reason }
    : { guardrail, decision: 'deny', reason, details };
}
