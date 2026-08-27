/** Time is an injected dependency so runs are deterministic under test. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Test double. Never use in production code paths. */
export class FixedClock implements Clock {
  #current: Date;

  constructor(start: Date | string | number = 0) {
    this.#current = new Date(start);
  }

  now(): Date {
    return new Date(this.#current);
  }

  advance(milliseconds: number): void {
    this.#current = new Date(this.#current.getTime() + milliseconds);
  }

  set(next: Date | string | number): void {
    this.#current = new Date(next);
  }
}

export function toIsoString(clock: Clock): string {
  return clock.now().toISOString();
}
