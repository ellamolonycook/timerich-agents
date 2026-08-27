import type { Guardrail, GuardrailEvaluation, GuardrailInput, GuardrailResult } from './types.js';
import { deny } from './types.js';

/**
 * Evaluates every guardrail and reports all denials rather than
 * short-circuiting, so a reviewer sees every reason an item was blocked.
 *
 * A guardrail that throws is treated as a denial: a broken policy check must
 * never fail open.
 */
export class GuardrailChain {
  readonly #guardrails: readonly Guardrail[];

  constructor(guardrails: readonly Guardrail[] = []) {
    this.#guardrails = guardrails;
  }

  get names(): readonly string[] {
    return this.#guardrails.map((guardrail) => guardrail.name);
  }

  with(guardrail: Guardrail): GuardrailChain {
    return new GuardrailChain([...this.#guardrails, guardrail]);
  }

  async evaluate(input: GuardrailInput): Promise<GuardrailEvaluation> {
    const results: GuardrailResult[] = [];
    for (const guardrail of this.#guardrails) {
      try {
        results.push(await guardrail.evaluate(input));
      } catch (error) {
        results.push(
          deny(guardrail.name, 'Guardrail threw while evaluating, failing closed', {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    const denials = results.filter((result) => result.decision === 'deny');
    return {
      allowed: denials.length === 0,
      evaluatedAt: input.now.toISOString(),
      results,
      denials,
    };
  }
}
