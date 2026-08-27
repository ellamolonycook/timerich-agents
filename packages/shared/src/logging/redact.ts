export const REDACTED = '[redacted]';

/**
 * Keys whose values must never reach a log sink. Matched case-insensitively
 * against the whole key, so `apiKey`, `API_KEY` and `authorization` all match.
 */
const DEFAULT_SENSITIVE_KEY_PATTERN =
  /(^|[_\-.])(secret|token|password|passwd|credential|authorization|auth|api[_\-.]?key|access[_\-.]?key|private[_\-.]?key)([_\-.]|$)|^key$/i;

const MAX_DEPTH = 6;

export interface RedactOptions {
  readonly pattern?: RegExp;
}

/**
 * Deep-copies `value`, replacing values under sensitive keys with `[redacted]`.
 * Cycles are broken rather than throwing, because logging must never crash a run.
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const pattern = options.pattern ?? DEFAULT_SENSITIVE_KEY_PATTERN;
  return walk(value, pattern, 0, new WeakSet<object>());
}

function walk(value: unknown, pattern: RegExp, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => walk(entry, pattern, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key, pattern) ? REDACTED : walk(entry, pattern, depth + 1, seen);
  }
  return out;
}

export function isSensitiveKey(key: string, pattern: RegExp = DEFAULT_SENSITIVE_KEY_PATTERN): boolean {
  pattern.lastIndex = 0;
  return pattern.test(key);
}
