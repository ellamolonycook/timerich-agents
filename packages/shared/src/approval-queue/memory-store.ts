import type { ApprovalItem, ApprovalListFilter, ApprovalStore } from './types.js';

/**
 * Process-local approval store. Fine for tests and single-process development;
 * production swaps in a durable `ApprovalStore` without touching agent code.
 */
export class InMemoryApprovalStore implements ApprovalStore {
  readonly #items = new Map<string, ApprovalItem>();

  async create(item: ApprovalItem): Promise<ApprovalItem> {
    this.#items.set(item.id, item);
    return item;
  }

  async get(id: string): Promise<ApprovalItem | undefined> {
    return this.#items.get(id);
  }

  async update(item: ApprovalItem): Promise<ApprovalItem> {
    this.#items.set(item.id, item);
    return item;
  }

  async list(filter: ApprovalListFilter = {}): Promise<readonly ApprovalItem[]> {
    return [...this.#items.values()].filter((item) => {
      if (filter.status !== undefined && item.status !== filter.status) return false;
      if (filter.agentId !== undefined && item.intent.agentId !== filter.agentId) return false;
      if (filter.runId !== undefined && item.intent.runId !== filter.runId) return false;
      return true;
    });
  }

  clear(): void {
    this.#items.clear();
  }
}
