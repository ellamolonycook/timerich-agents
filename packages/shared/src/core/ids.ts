import { randomUUID } from 'node:crypto';

/** Identifier generation is injected so tests can assert on stable ids. */
export interface IdGenerator {
  next(prefix?: string): string;
}

export const uuidIdGenerator: IdGenerator = {
  next(prefix?: string): string {
    const id = randomUUID();
    return prefix === undefined ? id : `${prefix}_${id}`;
  },
};

/** Test double producing `prefix_1`, `prefix_2`, ... */
export class SequentialIdGenerator implements IdGenerator {
  #counter = 0;

  next(prefix?: string): string {
    this.#counter += 1;
    return prefix === undefined ? String(this.#counter) : `${prefix}_${this.#counter}`;
  }
}
