import { ConfigurationError } from '../core/errors.js';
import type { LogLevel } from '../logging/types.js';
import { LOG_LEVELS } from '../logging/types.js';
import type { EnvSource } from './secret-provider.js';
import type { RuntimeEnvironment } from './types.js';

export interface RuntimeConfig {
  readonly environment: RuntimeEnvironment;
  readonly logLevel: LogLevel;
  /** When true, connectors must not perform real external side effects. */
  readonly dryRun: boolean;
  /** How long an approval item stays actionable before it expires. */
  readonly approvalTtlMinutes: number;
}

const ENVIRONMENTS: readonly RuntimeEnvironment[] = ['development', 'staging', 'production'];

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  environment: 'development',
  logLevel: 'info',
  dryRun: true,
  approvalTtlMinutes: 1440,
};

/**
 * Builds the runtime config from environment variables. Unknown values fail
 * loudly at startup rather than silently defaulting in production.
 */
export function loadRuntimeConfig(env: EnvSource = process.env): RuntimeConfig {
  return {
    environment: parseEnum(
      'TIMERICH_ENV',
      env['TIMERICH_ENV'],
      ENVIRONMENTS,
      DEFAULT_RUNTIME_CONFIG.environment,
    ),
    logLevel: parseEnum(
      'TIMERICH_LOG_LEVEL',
      env['TIMERICH_LOG_LEVEL'],
      LOG_LEVELS,
      DEFAULT_RUNTIME_CONFIG.logLevel,
    ),
    dryRun: parseBoolean('TIMERICH_DRY_RUN', env['TIMERICH_DRY_RUN'], DEFAULT_RUNTIME_CONFIG.dryRun),
    approvalTtlMinutes: parsePositiveInteger(
      'TIMERICH_APPROVAL_TTL_MINUTES',
      env['TIMERICH_APPROVAL_TTL_MINUTES'],
      DEFAULT_RUNTIME_CONFIG.approvalTtlMinutes,
    ),
  };
}

function parseEnum<T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (raw === undefined || raw === '') return fallback;
  const match = allowed.find((candidate) => candidate === raw);
  if (match === undefined) {
    throw new ConfigurationError(
      `${name} must be one of: ${allowed.join(', ')}`,
      { variable: name, received: raw },
    );
  }
  return match;
}

function parseBoolean(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new ConfigurationError(`${name} must be a boolean ("true" or "false")`, {
    variable: name,
    received: raw,
  });
}

function parsePositiveInteger(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigurationError(`${name} must be a positive integer`, {
      variable: name,
      received: raw,
    });
  }
  return parsed;
}
