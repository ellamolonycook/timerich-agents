import { describe, expect, it } from 'vitest';
import {
  FixedClock,
  GuardrailChain,
  NoopRateLimiter,
  TokenBucketRateLimiter,
  ValidationError,
  allow,
  deny,
  outboundCompletenessGuardrail,
  rateLimitGuardrail,
  type Guardrail,
  type GuardrailInput,
} from '../src/index.js';
import { START, anIntent } from './support.js';

function input(overrides: Partial<GuardrailInput> = {}): GuardrailInput {
  return {
    agentId: 'test-agent',
    action: 'outbound-send',
    now: START,
    intent: anIntent(),
    ...overrides,
  };
}

describe('GuardrailChain', () => {
  it('allows when every guardrail allows', async () => {
    const chain = new GuardrailChain([outboundCompletenessGuardrail()]);
    const evaluation = await chain.evaluate(input());
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.denials).toHaveLength(0);
  });

  it('collects every denial rather than stopping at the first', async () => {
    const first: Guardrail = { name: 'first', evaluate: () => deny('first', 'nope') };
    const second: Guardrail = { name: 'second', evaluate: () => deny('second', 'also nope') };
    const third: Guardrail = { name: 'third', evaluate: () => allow('third') };

    const evaluation = await new GuardrailChain([first, second, third]).evaluate(input());

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.denials.map((d) => d.guardrail)).toEqual(['first', 'second']);
    expect(evaluation.results).toHaveLength(3);
  });

  it('fails closed when a guardrail throws', async () => {
    const broken: Guardrail = {
      name: 'broken',
      evaluate: () => {
        throw new Error('policy service unreachable');
      },
    };

    const evaluation = await new GuardrailChain([broken]).evaluate(input());

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.denials[0]?.guardrail).toBe('broken');
  });

  it('is immutable when extended with `with`', async () => {
    const base = new GuardrailChain();
    const extended = base.with(outboundCompletenessGuardrail());
    expect(base.names).toEqual([]);
    expect(extended.names).toEqual(['outbound-completeness']);
  });
});

describe('outboundCompletenessGuardrail', () => {
  it.each([
    ['no recipient address', anIntent({ message: { channel: 'email', to: { address: '' }, body: 'hi' } })],
    ['empty body', anIntent({ message: { channel: 'email', to: { address: 'a@b.com' }, body: ' ' } })],
    ['no reason', anIntent({ reason: '' })],
  ])('denies an intent with %s', async (_label, intent) => {
    const evaluation = await new GuardrailChain([outboundCompletenessGuardrail()]).evaluate(
      input({ intent }),
    );
    expect(evaluation.allowed).toBe(false);
  });

  it('ignores non-outbound actions', async () => {
    const evaluation = await new GuardrailChain([outboundCompletenessGuardrail()]).evaluate(
      { agentId: 'test-agent', action: 'data-read', now: START },
    );
    expect(evaluation.allowed).toBe(true);
  });
});

describe('TokenBucketRateLimiter', () => {
  it('allows up to capacity, then denies with a retry hint', async () => {
    const clock = new FixedClock(START);
    const limiter = new TokenBucketRateLimiter({
      capacity: 2,
      refillTokens: 1,
      refillIntervalMs: 1000,
      clock,
    });

    expect((await limiter.consume('a')).allowed).toBe(true);
    expect((await limiter.consume('a')).allowed).toBe(true);

    const denied = await limiter.consume('a');
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBe(1000);
  });

  it('refills over time up to capacity', async () => {
    const clock = new FixedClock(START);
    const limiter = new TokenBucketRateLimiter({
      capacity: 2,
      refillTokens: 1,
      refillIntervalMs: 1000,
      clock,
    });
    await limiter.consume('a');
    await limiter.consume('a');

    clock.advance(1000);
    expect((await limiter.consume('a')).allowed).toBe(true);

    clock.advance(60_000);
    expect((await limiter.peek('a')).remaining).toBe(2);
  });

  it('keys buckets independently', async () => {
    const limiter = new TokenBucketRateLimiter({
      capacity: 1,
      refillTokens: 1,
      refillIntervalMs: 1000,
      clock: new FixedClock(START),
    });
    expect((await limiter.consume('a')).allowed).toBe(true);
    expect((await limiter.consume('a')).allowed).toBe(false);
    expect((await limiter.consume('b')).allowed).toBe(true);
  });

  it('rejects an invalid configuration', () => {
    expect(
      () => new TokenBucketRateLimiter({ capacity: 0, refillTokens: 1, refillIntervalMs: 1 }),
    ).toThrow(ValidationError);
  });

  it('never limits under the noop limiter', async () => {
    const limiter = new NoopRateLimiter();
    expect((await limiter.consume('a')).allowed).toBe(true);
  });
});

describe('rateLimitGuardrail', () => {
  it('denies once the bucket is empty', async () => {
    const limiter = new TokenBucketRateLimiter({
      capacity: 1,
      refillTokens: 1,
      refillIntervalMs: 1000,
      clock: new FixedClock(START),
    });
    const chain = new GuardrailChain([rateLimitGuardrail({ limiter })]);

    expect((await chain.evaluate(input())).allowed).toBe(true);
    const second = await chain.evaluate(input());
    expect(second.allowed).toBe(false);
    expect(second.denials[0]?.reason).toBe('Rate limit exceeded');
  });
});
