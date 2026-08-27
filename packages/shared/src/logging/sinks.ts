import type { LogRecord, LogSink } from './types.js';

/** Collects records in memory. Intended for tests and local inspection. */
export class MemoryLogSink implements LogSink {
  readonly records: LogRecord[] = [];

  write(record: LogRecord): void {
    this.records.push(record);
  }

  clear(): void {
    this.records.length = 0;
  }

  messages(): string[] {
    return this.records.map((record) => record.message);
  }
}

/** One JSON object per line on stdout/stderr - the production default. */
export class JsonConsoleSink implements LogSink {
  readonly #console: Pick<Console, 'log' | 'error'>;

  constructor(target: Pick<Console, 'log' | 'error'> = console) {
    this.#console = target;
  }

  write(record: LogRecord): void {
    const line = JSON.stringify(record);
    if (record.level === 'error') {
      this.#console.error(line);
    } else {
      this.#console.log(line);
    }
  }
}

/** Drops everything. Useful as a default in tests. */
export class NullLogSink implements LogSink {
  write(): void {
    /* intentionally empty */
  }
}
