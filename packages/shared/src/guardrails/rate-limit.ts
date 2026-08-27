import type { Clock } from '../core/clock.js';
import { systemClock } from '../core/clock.js';
import { ValidationError } from '../core/errors.js';

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Whole tokens left in the bucket after this call. */
  readonly remaining: number;
  /** Milliseconds until the request would succeed. Zero when allowed. */
  readonly retryAfterMs: number;
  readonly limit: number;
}

export interface RateLimiter {
  /** Attempts to spend `cost` tokens against `key`. */
  consume(key: string, cost?: number): Promise<RateLimitDecision>;
  /** Reads the current state without spending. */
  peek(key: string): Promise<RateLimitDecision>;
}

export interface TokenBucketOptions {
  /** Maximum burst size. */
  readonly capacity: number;
  /** Tokens added per `refillIntervalMs`. */
  readonly refillTokens: number;
  readonly refillIntervalMs: number;
  readonly clock?: Clock;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/**
 * In-memory token bucket, keyed per agent/connector/recipient as the caller
 * chooses. Single-process only; a shared backend implements `RateLimiter` the
 * same way when the runtime becomes multi-process.
 */
export class TokenBucketRateLimiter implements RateLimiter {
  readonly #capacity: number;
  readonly #refillTokens: number;
  readonly #refillIntervalMs: number;
  readonly #clock: Clock;
  readonly #buckets = new Map<string, Bucket>();

  constructor(options: TokenBucketOptions) {
    if (options.capacity <= 0) {
      throw new ValidationError('Rate limiter capacity must be greater than 0');
    }
    if (options.refillTokens <= 0 || options.refillIntervalMs <= 0) {
      throw new ValidationError('Rate limiter refill rate must be greater than 0');
    }
    this.#capacity = options.capacity;
    this.#refillTokens = options.refillTokens;
    this.#refillIntervalMs = options.refillIntervalMs;
    this.#clock = options.clock ?? systemClock;
  }

  async consume(key: string, cost = 1): Promise<RateLimitDecision> {
    if (cost <= 0) throw new ValidationError('Rate limit cost must be greater than 0');
    const bucket = this.#refill(key);
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return this.#decision(bucket, true, 0);
    }
    return this.#decision(bucket, false, this.#retryAfterMs(bucket.tokens, cost));
  }

  async peek(key: string): Promise<RateLimitDecision> {
    const bucket = this.#refill(key);
    const allowed = bucket.tokens >= 1;
    return this.#decision(bucket, allowed, allowed ? 0 : this.#retryAfterMs(bucket.tokens, 1));
  }

  /** Drops all buckets. Used between test cases and on operator reset. */
  reset(): void {
    this.#buckets.clear();
  }

  #refill(key: string): Bucket {
    const nowMs = this.#clock.now().getTime();
    const existing = this.#buckets.get(key);
    if (existing === undefined) {
      const created: Bucket = { tokens: this.#capacity, lastRefillMs: nowMs };
      this.#buckets.set(key, created);
      return created;
    }
    const elapsed = nowMs - existing.lastRefillMs;
    if (elapsed >= this.#refillIntervalMs) {
      const intervals = Math.floor(elapsed / this.#refillIntervalMs);
      existing.tokens = Math.min(this.#capacity, existing.tokens + intervals * this.#refillTokens);
      existing.lastRefillMs += intervals * this.#refillIntervalMs;
    }
    return existing;
  }

  #retryAfterMs(tokens: number, cost: number): number {
    const deficit = cost - tokens;
    const intervals = Math.ceil(deficit / this.#refillTokens);
    return intervals * this.#refillIntervalMs;
  }

  #decision(bucket: Bucket, allowed: boolean, retryAfterMs: number): RateLimitDecision {
    return {
      allowed,
      remaining: Math.floor(bucket.tokens),
      retryAfterMs,
      limit: this.#capacity,
    };
  }
}

/** Always allows. Only for tests and for agents with no rate policy yet. */
export class NoopRateLimiter implements RateLimiter {
  async consume(_key: string, _cost = 1): Promise<RateLimitDecision> {
    return {
      allowed: true,
      remaining: Number.POSITIVE_INFINITY,
      retryAfterMs: 0,
      limit: Number.POSITIVE_INFINITY,
    };
  }

  async peek(key: string): Promise<RateLimitDecision> {
    return this.consume(key);
  }
}
