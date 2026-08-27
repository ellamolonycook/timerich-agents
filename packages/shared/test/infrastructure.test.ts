import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  ConnectorRegistry,
  DEFAULT_RUNTIME_CONFIG,
  EnvSecretProvider,
  FixedClock,
  InMemorySecretProvider,
  MemoryLogSink,
  REDACTED,
  SequentialIdGenerator,
  createLogger,
  loadRuntimeConfig,
  redact,
  secretRef,
} from '../src/index.js';
import { RecordingOutboundConnector, START } from './support.js';

describe('structured logging', () => {
  it('emits records at or above the configured level', () => {
    const sink = new MemoryLogSink();
    const logger = createLogger({ sink, level: 'warn', clock: new FixedClock(START) });

    logger.debug('dropped');
    logger.info('dropped');
    logger.warn('kept');
    logger.error('kept too');

    expect(sink.messages()).toEqual(['kept', 'kept too']);
    expect(sink.records[0]?.timestamp).toBe(START.toISOString());
  });

  it('merges base fields and child bindings into every record', () => {
    const sink = new MemoryLogSink();
    const logger = createLogger({ sink, base: { agentId: 'podcast-outreach' } });

    logger.child({ runId: 'run_1' }).info('started', { campaignId: 'c1' });

    expect(sink.records[0]?.fields).toEqual({
      agentId: 'podcast-outreach',
      runId: 'run_1',
      campaignId: 'c1',
    });
  });

  it('redacts secret-shaped fields before they reach the sink', () => {
    const sink = new MemoryLogSink();
    createLogger({ sink }).info('connector configured', {
      connectorId: 'email.primary',
      apiKey: 'super-secret',
      nested: { authorization: 'Bearer abc', showName: 'The Pod' },
    });

    expect(sink.records[0]?.fields).toEqual({
      connectorId: 'email.primary',
      apiKey: REDACTED,
      nested: { authorization: REDACTED, showName: 'The Pod' },
    });
  });

  it('survives circular structures', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
    expect(redact(cyclic)).toEqual({ name: 'loop', self: '[circular]' });
  });
});

describe('configuration and secrets', () => {
  it('falls back to safe defaults, including dry run', () => {
    expect(loadRuntimeConfig({})).toEqual(DEFAULT_RUNTIME_CONFIG);
    expect(DEFAULT_RUNTIME_CONFIG.dryRun).toBe(true);
  });

  it('parses a full environment', () => {
    expect(
      loadRuntimeConfig({
        TIMERICH_ENV: 'production',
        TIMERICH_LOG_LEVEL: 'warn',
        TIMERICH_DRY_RUN: 'false',
        TIMERICH_APPROVAL_TTL_MINUTES: '60',
      }),
    ).toEqual({
      environment: 'production',
      logLevel: 'warn',
      dryRun: false,
      approvalTtlMinutes: 60,
    });
  });

  it.each([
    ['TIMERICH_ENV', { TIMERICH_ENV: 'prod' }],
    ['TIMERICH_DRY_RUN', { TIMERICH_DRY_RUN: 'maybe' }],
    ['TIMERICH_APPROVAL_TTL_MINUTES', { TIMERICH_APPROVAL_TTL_MINUTES: '-5' }],
  ])('rejects an invalid %s rather than defaulting', (_name, env) => {
    expect(() => loadRuntimeConfig(env)).toThrow(ConfigurationError);
  });

  it('reports a missing secret by name and never by value', async () => {
    const provider = new EnvSecretProvider({ PRESENT: 'value' });
    await expect(provider.get(secretRef('PRESENT'))).resolves.toBe('value');
    await expect(provider.has(secretRef('ABSENT'))).resolves.toBe(false);
    await expect(provider.get(secretRef('ABSENT'))).rejects.toThrow(/ABSENT/);
  });

  it('resolves seeded secrets in memory', async () => {
    const provider = new InMemorySecretProvider({ TOKEN: 'abc' });
    await expect(provider.get(secretRef('TOKEN'))).resolves.toBe('abc');
  });
});

describe('connector registry', () => {
  it('registers, resolves and narrows outbound connectors', () => {
    const connector = new RecordingOutboundConnector();
    const registry = new ConnectorRegistry().register(connector);

    expect(registry.require('email.primary')).toBe(connector);
    expect(registry.requireOutbound('email.primary')).toBe(connector);
    expect(registry.list()).toHaveLength(1);
  });

  it('rejects duplicate and unknown ids', () => {
    const registry = new ConnectorRegistry().register(new RecordingOutboundConnector());
    expect(() => registry.register(new RecordingOutboundConnector())).toThrow(ConfigurationError);
    expect(() => registry.require('missing')).toThrow(ConfigurationError);
    expect(registry.get('missing')).toBeUndefined();
  });

  it('exposes a reader that cannot register', () => {
    const reader = new ConnectorRegistry().register(new RecordingOutboundConnector()).asReader();
    expect('register' in reader).toBe(false);
  });
});

describe('id generation', () => {
  it('produces stable sequential ids for tests', () => {
    const ids = new SequentialIdGenerator();
    expect([ids.next('apr'), ids.next('apr'), ids.next()]).toEqual(['apr_1', 'apr_2', '3']);
  });
});
