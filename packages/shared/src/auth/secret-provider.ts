import { ConfigurationError } from '../core/errors.js';
import type { SecretProvider, SecretRef } from './types.js';

export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Reads secrets from the process environment (or any injected record).
 * Errors mention only the secret *name*, never its value.
 */
export class EnvSecretProvider implements SecretProvider {
  readonly #env: EnvSource;

  constructor(env: EnvSource = process.env) {
    this.#env = env;
  }

  async get(ref: SecretRef): Promise<string> {
    const value = this.#env[ref.name];
    if (value === undefined || value === '') {
      throw new ConfigurationError(`Missing secret '${ref.name}'`, { secret: ref.name });
    }
    return value;
  }

  async has(ref: SecretRef): Promise<boolean> {
    const value = this.#env[ref.name];
    return value !== undefined && value !== '';
  }
}

/** Test double. Seed it explicitly; it reads no ambient state. */
export class InMemorySecretProvider implements SecretProvider {
  readonly #values: Map<string, string>;

  constructor(values: Readonly<Record<string, string>> = {}) {
    this.#values = new Map(Object.entries(values));
  }

  set(name: string, value: string): void {
    this.#values.set(name, value);
  }

  async get(ref: SecretRef): Promise<string> {
    const value = this.#values.get(ref.name);
    if (value === undefined) {
      throw new ConfigurationError(`Missing secret '${ref.name}'`, { secret: ref.name });
    }
    return value;
  }

  async has(ref: SecretRef): Promise<boolean> {
    return this.#values.has(ref.name);
  }
}
