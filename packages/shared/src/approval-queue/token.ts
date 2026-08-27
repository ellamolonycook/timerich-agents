/**
 * The hard boundary.
 *
 * `ApprovalToken` carries a brand keyed by a `unique symbol` that has no
 * runtime value, so the *only* way to obtain one is `mintApprovalToken`, which
 * lives here and is deliberately NOT re-exported from the package entry point.
 *
 * `OutboundConnector.send` requires a token. Therefore an agent - which can
 * only import the package entry point - cannot construct one and cannot call
 * `send`. Every external send has to travel through the approval queue.
 */

export declare const APPROVAL_TOKEN_BRAND: unique symbol;

export interface ApprovalToken {
  readonly [APPROVAL_TOKEN_BRAND]: 'approved';
  /** Approval queue item this token authorises. */
  readonly approvalId: string;
  /** Human (or system account) that recorded the approval. */
  readonly decidedBy: string;
  readonly decidedAt: string;
}

export type ApprovalTokenFields = Omit<ApprovalToken, typeof APPROVAL_TOKEN_BRAND>;

/**
 * Internal to `@timerich/shared`. Only `ApprovalQueue` calls this, and only
 * after a decision has been recorded against a stored item.
 */
export function mintApprovalToken(fields: ApprovalTokenFields): ApprovalToken {
  return Object.freeze({ ...fields }) as ApprovalToken;
}

/** Reads the branded fields back out for auditing. */
export function describeApprovalToken(token: ApprovalToken): ApprovalTokenFields {
  return {
    approvalId: token.approvalId,
    decidedBy: token.decidedBy,
    decidedAt: token.decidedAt,
  };
}
