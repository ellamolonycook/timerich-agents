import type { ConnectorReader } from '../connectors/registry.js';
import type { DeliveryReceipt } from '../connectors/types.js';
import type { Logger } from '../logging/types.js';
import type { ApprovalQueue } from './queue.js';
import type { ApprovalItem } from './types.js';

export type DispatchResult =
  | { readonly status: 'dispatched'; readonly item: ApprovalItem; readonly delivery: DeliveryReceipt }
  | { readonly status: 'failed'; readonly item: ApprovalItem; readonly error: string };

export interface ApprovalDispatcherDeps {
  readonly queue: ApprovalQueue;
  readonly connectors: ConnectorReader;
  readonly logger: Logger;
}

/**
 * Operator-side half of the boundary. Runs after a human approves an item;
 * it is never wired into an agent context.
 *
 * `claimApproved` throws unless the item is genuinely approved, so this class
 * cannot be tricked into sending something a reviewer has not seen.
 */
export class ApprovalDispatcher {
  readonly #queue: ApprovalQueue;
  readonly #connectors: ConnectorReader;
  readonly #logger: Logger;

  constructor(deps: ApprovalDispatcherDeps) {
    this.#queue = deps.queue;
    this.#connectors = deps.connectors;
    this.#logger = deps.logger.child({ component: 'approval-dispatcher' });
  }

  async dispatch(approvalId: string): Promise<DispatchResult> {
    const { item, token } = await this.#queue.claimApproved(approvalId);
    const connector = this.#connectors.requireOutbound(item.intent.connectorId);

    try {
      const delivery = await connector.send(item.intent.message, token);
      const dispatched = await this.#queue.markDispatched(item.id, delivery);
      this.#logger.info('Approved outbound message dispatched', {
        approvalId: item.id,
        connectorId: connector.descriptor.id,
        channel: delivery.channel,
        dryRun: delivery.dryRun,
      });
      return { status: 'dispatched', item: dispatched, delivery };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await this.#queue.markFailed(item.id, message);
      this.#logger.error('Approved outbound message failed to dispatch', {
        approvalId: item.id,
        connectorId: connector.descriptor.id,
        error: message,
      });
      return { status: 'failed', item: failed, error: message };
    }
  }

  /** Dispatches every currently approved item, oldest first. */
  async dispatchApproved(): Promise<readonly DispatchResult[]> {
    const approved = await this.#queue.list({ status: 'approved' });
    const ordered = [...approved].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const results: DispatchResult[] = [];
    for (const item of ordered) {
      results.push(await this.dispatch(item.id));
    }
    return results;
  }
}
