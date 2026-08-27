/**
 * A *reference* to a secret - never the secret itself. Manifests, descriptors
 * and logs carry `SecretRef`s so the value only ever exists inside a
 * `SecretProvider` and the connector that resolves it.
 */
export interface SecretRef {
  readonly name: string;
  readonly description?: string;
}

export function secretRef(name: string, description?: string): SecretRef {
  return description === undefined ? { name } : { name, description };
}

export interface SecretProvider {
  /** Resolves the secret, or throws `ConfigurationError` when absent. */
  get(ref: SecretRef): Promise<string>;
  has(ref: SecretRef): Promise<boolean>;
}

export type RuntimeEnvironment = 'development' | 'staging' | 'production';
