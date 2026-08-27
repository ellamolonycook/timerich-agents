import type { Clock } from '../core/clock.js';
import type { IdGenerator } from '../core/ids.js';
import { ApprovalRequiredError, ApprovalStateError } from '../core/errors.js';
import type { Logger } from '../logging/types.js';
import type { DeliveryReceipt } from '../connectors/types.js';
import type { GuardrailEvaluation } from '../guardrails/types.js';
import { mintApprovalToken, type ApprovalToken } from './token.js';
import {
  isTerminalStatus,
  type ApprovalItem,
  type ApprovalListFilter,
  type ApprovalStatus,
  type ApprovalStore,
  type OutboundIntent,
} from './types.js';

export interface ApprovalQueueDeps {
  readonly store: ApprovalStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  /** How long a pending item stays actionable. */
  readonly ttlMinutes: number;
}

export interface DecisionInput {
  readonly decidedBy: string;
  readonly note?: string;
}

/**
 * The approval boundary.
 *
 * Agents only ever reach `submit`. Approving, rejecting and claiming are
 * operator-side actions. `claimApproved` is the sole source of `ApprovalToken`,
 * and an `OutboundConnector` cannot send without one.
 */
export class ApprovalQueue {
  readonly #store: ApprovalStore;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #logger: Logger;
  readonly #ttlMs: number;

  constructor(deps: ApprovalQueueDeps) {
    this.#store = deps.store;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#logger = deps.logger.child({ component: 'approval-queue' });
    this.#ttlMs = deps.ttlMinutes * 60_000;
  }

  /**
   * Records an intent for review. A guardrail denial is stored as `blocked`
   * rather than dropped, so the reviewer can see what the agent tried to do.
   */
  async submit(intent: OutboundIntent, guardrail: GuardrailEvaluation): Promise<ApprovalItem> {
    const now = this.#clock.now();
    const nowIso = now.toISOString();
    const item: ApprovalItem = {
      id: this.#ids.next('apr'),
      status: guardrail.allowed ? 'pending' : 'blocked',
      intent,
      guardrail,
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt: new Date(now.getTime() + this.#ttlMs).toISOString(),
    };
    const created = await this.#store.create(item);
    this.#logger.info('Outbound intent queued for approval', {
      approvalId: created.id,
      agentId: intent.agentId,
      channel: intent.channel,
      connectorId: intent.connectorId,
      status: created.status,
      denials: guardrail.denials.map((denial) => denial.guardrail),
    });
    return created;
  }

  async get(id: string): Promise<ApprovalItem | undefined> {
    const item = await this.#store.get(id);
    if (item === undefined) return undefined;
    return this.#expireIfDue(item);
  }

  async require(id: string): Promise<ApprovalItem> {
    const item = await this.get(id);
    if (item === undefined) {
      throw new ApprovalStateError(`Approval item '${id}' not found`, { approvalId: id });
    }
    return item;
  }

  async list(filter?: ApprovalListFilter): Promise<readonly ApprovalItem[]> {
    const items = await this.#store.list(filter);
    return Promise.all(items.map((item) => this.#expireIfDue(item)));
  }

  async listPending(agentId?: string): Promise<readonly ApprovalItem[]> {
    const items = await this.list(
      agentId === undefined ? { status: 'pending' } : { status: 'pending', agentId },
    );
    return items.filter((item) => item.status === 'pending');
  }

  async approve(id: string, input: DecisionInput): Promise<ApprovalItem> {
    return this.#decide(id, 'approved', input);
  }

  async reject(id: string, input: DecisionInput): Promise<ApprovalItem> {
    return this.#decide(id, 'rejected', input);
  }

  /**
   * Mints the token that authorises exactly one send. Only an item a human has
   * approved yields a token; everything else throws.
   */
  async claimApproved(id: string): Promise<{ item: ApprovalItem; token: ApprovalToken }> {
    const item = await this.require(id);
    if (item.status !== 'approved') {
      throw new ApprovalRequiredError(
        `Approval item '${id}' is '${item.status}', not 'approved'; refusing to authorise a send`,
        { approvalId: id, status: item.status },
      );
    }
    const decision = item.decision;
    if (decision === undefined) {
      throw new ApprovalStateError(`Approval item '${id}' is approved but has no decision record`, {
        approvalId: id,
      });
    }
    const token = mintApprovalToken({
      approvalId: item.id,
      decidedBy: decision.decidedBy,
      decidedAt: decision.decidedAt,
    });
    return { item, token };
  }

  async markDispatched(id: string, delivery: DeliveryReceipt): Promise<ApprovalItem> {
    const item = await this.require(id);
    return this.#transition(item, 'dispatched', { delivery });
  }

  async markFailed(id: string, failure: string): Promise<ApprovalItem> {
    const item = await this.require(id);
    return this.#transition(item, 'failed', { failure });
  }

  async #decide(
    id: string,
    status: 'approved' | 'rejected',
    input: DecisionInput,
  ): Promise<ApprovalItem> {
    const item = await this.require(id);
    if (item.status !== 'pending') {
      throw new ApprovalStateError(
        `Approval item '${id}' is '${item.status}' and can no longer be decided`,
        { approvalId: id, status: item.status },
      );
    }
    const decidedAt = this.#clock.now().toISOString();
    const decision =
      input.note === undefined
        ? { status, decidedBy: input.decidedBy, decidedAt }
        : { status, decidedBy: input.decidedBy, decidedAt, note: input.note };
    const updated = await this.#transition(item, status, { decision });
    this.#logger.info('Approval decision recorded', {
      approvalId: id,
      status,
      decidedBy: input.decidedBy,
    });
    return updated;
  }

  async #transition(
    item: ApprovalItem,
    status: ApprovalStatus,
    patch: Partial<Pick<ApprovalItem, 'decision' | 'delivery' | 'failure'>>,
  ): Promise<ApprovalItem> {
    if (isTerminalStatus(item.status)) {
      throw new ApprovalStateError(
        `Approval item '${item.id}' is terminal ('${item.status}') and cannot change`,
        { approvalId: item.id, status: item.status },
      );
    }
    const next: ApprovalItem = {
      ...item,
      ...patch,
      status,
      updatedAt: this.#clock.now().toISOString(),
    };
    return this.#store.update(next);
  }

  /** Lazily expires pending items whose TTL has elapsed. */
  async #expireIfDue(item: ApprovalItem): Promise<ApprovalItem> {
    if (item.status !== 'pending') return item;
    if (this.#clock.now().getTime() < Date.parse(item.expiresAt)) return item;
    const expired: ApprovalItem = {
      ...item,
      status: 'expired',
      updatedAt: this.#clock.now().toISOString(),
    };
    this.#logger.warn('Approval item expired without a decision', { approvalId: item.id });
    return this.#store.update(expired);
  }
}
