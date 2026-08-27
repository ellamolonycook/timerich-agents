import type { Clock } from '../core/clock.js';
import { systemClock } from '../core/clock.js';
import { redact } from './redact.js';
import { NullLogSink } from './sinks.js';
import { LOG_LEVEL_WEIGHT, type LogFields, type LogLevel, type LogSink, type Logger } from './types.js';

export interface LoggerOptions {
  readonly sink?: LogSink;
  readonly level?: LogLevel;
  /** Fields merged into every record, e.g. `{ agentId, runId }`. */
  readonly base?: LogFields;
  readonly clock?: Clock;
  /** Override the key pattern used to redact sensitive values. */
  readonly redactPattern?: RegExp;
}

/**
 * Structured logger. Every record is redacted before it reaches the sink, so a
 * secret accidentally passed in `fields` never lands in the log stream.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? new NullLogSink();
  const level = options.level ?? 'info';
  const clock = options.clock ?? systemClock;
  const base = options.base ?? {};
  const threshold = LOG_LEVEL_WEIGHT[level];

  const emit = (recordLevel: LogLevel, message: string, fields?: LogFields): void => {
    if (LOG_LEVEL_WEIGHT[recordLevel] < threshold) return;
    const merged = { ...base, ...(fields ?? {}) };
    const redacted = redact(
      merged,
      options.redactPattern === undefined ? {} : { pattern: options.redactPattern },
    ) as LogFields;
    sink.write({
      timestamp: clock.now().toISOString(),
      level: recordLevel,
      message,
      fields: redacted,
    });
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields) =>
      createLogger({
        ...options,
        sink,
        level,
        clock,
        base: { ...base, ...fields },
      }),
  };
}
