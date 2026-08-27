import type { DeliveryReceipt, OutboundChannel, OutboundMessage } from '../connectors/types.js';
import type { GuardrailEvaluation } from '../guardrails/types.js';

export type ApprovalStatus =
  /** Waiting on a human decision. */
  | 'pending'
  /** A human approved it; not yet sent. */
  | 'approved'
  /** A human rejected it. Terminal. */
  | 'rejected'
  /** Guardrails denied it before a human ever saw it. Terminal. */
  | 'blocked'
  /** TTL elapsed without a decision. Terminal. */
  | 'expired'
  /** Handed to the connector and accepted. Terminal. */
  | 'dispatched'
  /** Approved, but the connector rejected it. Terminal. */
  | 'failed';

/**
 * What an agent asks for. It is a *request to send*, never a send. The agent
 * has no way to turn this into delivery on its own.
 */
export interface OutboundIntent {
  readonly agentId: string;
  /** Connector that would deliver it, resolved at dispatch time. */
  readonly connectorId: string;
  readonly channel: OutboundChannel;
  readonly message: OutboundMessage;
  /** Plain-language justification shown to the reviewer. Required. */
  readonly reason: string;
  /** Free-form flags for reviewer triage, e.g. `cold-contact`. */
  readonly riskTags?: readonly string[];
  /** Correlates the item back to the run that produced it. */
  readonly runId?: string;
}

export interface ApprovalDecision {
  readonly status: 'approved' | 'rejected';
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly note?: string;
}

export interface ApprovalItem {
  readonly id: string;
  readonly status: ApprovalStatus;
  readonly intent: OutboundIntent;
  readonly guardrail: GuardrailEvaluation;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly decision?: ApprovalDecision;
  readonly delivery?: DeliveryReceipt;
  readonly failure?: string;
}

export interface ApprovalListFilter {
  readonly status?: ApprovalStatus;
  readonly agentId?: string;
  readonly runId?: string;
}

/**
 * Persistence port. The in-memory implementation ships here; a durable store
 * (Postgres, Airtable, Notion) implements the same four methods.
 */
export interface ApprovalStore {
  create(item: ApprovalItem): Promise<ApprovalItem>;
  get(id: string): Promise<ApprovalItem | undefined>;
  update(item: ApprovalItem): Promise<ApprovalItem>;
  list(filter?: ApprovalListFilter): Promise<readonly ApprovalItem[]>;
}

/** Terminal states never transition again. */
export const TERMINAL_APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  'rejected',
  'blocked',
  'expired',
  'dispatched',
  'failed',
];

export function isTerminalStatus(status: ApprovalStatus): boolean {
  return TERMINAL_APPROVAL_STATUSES.includes(status);
}
