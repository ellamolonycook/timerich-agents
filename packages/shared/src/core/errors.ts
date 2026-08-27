/**
 * Error taxonomy shared by every agent.
 *
 * Agents should throw these rather than bare `Error` so the runtime can
 * distinguish an operator/configuration problem from a safety stop.
 */

export type TimeRichErrorCode =
  | 'configuration'
  | 'connector'
  | 'guardrail_violation'
  | 'approval_required'
  | 'approval_state'
  | 'rate_limited'
  | 'not_implemented'
  | 'validation';

export class TimeRichError extends Error {
  readonly code: TimeRichErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: TimeRichErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/** Missing or malformed configuration/secret. Never carries the secret value. */
export class ConfigurationError extends TimeRichError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('configuration', message, details);
  }
}

/** A connector failed to talk to its provider. */
export class ConnectorError extends TimeRichError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('connector', message, details);
  }
}

/** One or more guardrails denied the action. */
export class GuardrailViolationError extends TimeRichError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('guardrail_violation', message, details);
  }
}

/** Something tried to dispatch an item that has not been approved. */
export class ApprovalRequiredError extends TimeRichError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('approval_required', message, details);
  }
}

/** An approval item was moved through an illegal state transition. */
export class ApprovalStateError extends TimeRichError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('approval_state', message, details);
  }
}

export class RateLimitExceededError extends TimeRichError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('rate_limited', message, details);
  }
}

/** Deliberate placeholder for a capability that has not been built yet. */
export class NotImplementedError extends TimeRichError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('not_implemented', message, details);
  }
}

export class ValidationError extends TimeRichError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('validation', message, details);
  }
}
