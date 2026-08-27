/**
 * `@timerich/shared` - runtime infrastructure every Time Rich agent builds on.
 *
 * Agents import from this entry point only. Deep imports are blocked by the
 * package `exports` map, which is what keeps `mintApprovalToken` out of reach.
 */
export * from './core/index.js';
export * from './logging/index.js';
export * from './auth/index.js';
export * from './connectors/index.js';
export * from './guardrails/index.js';
export * from './approval-queue/index.js';
export * from './agent/index.js';
