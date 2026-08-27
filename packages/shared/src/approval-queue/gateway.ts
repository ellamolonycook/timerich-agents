import type { Clock } from '../core/clock.js';
import type { GuardrailChain } from '../guardrails/chain.js';
import type { GuardrailResult } from '../guardrails/types.js';
import type { ApprovalQueue } from './queue.js';
import type { OutboundIntent } from './types.js';

export type OutboundSubmission =
  | { readonly status: 'pending-approval'; readonly approvalId: string }
  | {
      readonly status: 'blocked';
      readonly approvalId: string;
      readonly denials: readonly GuardrailResult[];
    };

/**
 * The only outbound surface an agent is given.
 *
 * There is deliberately no `send`. `submit` runs the guardrail chain and files
 * the intent for review; delivery happens later, on the operator side, through
 * `ApprovalDispatcher`.
 */
export interface OutboundGateway {
  submit(intent: OutboundIntent): Promise<OutboundSubmission>;
}

export interface ApprovalGatedOutboundGatewayDeps {
  readonly queue: ApprovalQueue;
  readonly guardrails: GuardrailChain;
  readonly clock: Clock;
}

export class ApprovalGatedOutboundGateway implements OutboundGateway {
  readonly #queue: ApprovalQueue;
  readonly #guardrails: GuardrailChain;
  readonly #clock: Clock;

  constructor(deps: ApprovalGatedOutboundGatewayDeps) {
    this.#queue = deps.queue;
    this.#guardrails = deps.guardrails;
    this.#clock = deps.clock;
  }

  async submit(intent: OutboundIntent): Promise<OutboundSubmission> {
    const evaluation = await this.#guardrails.evaluate({
      agentId: intent.agentId,
      action: 'outbound-send',
      now: this.#clock.now(),
      intent,
    });
    const item = await this.#queue.submit(intent, evaluation);
    return evaluation.allowed
      ? { status: 'pending-approval', approvalId: item.id }
      : { status: 'blocked', approvalId: item.id, denials: evaluation.denials };
  }
}
