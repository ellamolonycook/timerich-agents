import { NotImplementedError } from '@timerich/shared';
import type { OutreachComposer } from './types.js';

/**
 * Default composer. Drafting real pitches is a later task, so the scaffold
 * fails loudly rather than shipping a silent placeholder pitch.
 *
 * Tests and future implementations inject their own `OutreachComposer`.
 */
export function notImplementedComposer(): OutreachComposer {
  return {
    async compose(target): Promise<never> {
      throw new NotImplementedError(
        'Podcast outreach composition is not implemented yet; inject an OutreachComposer',
        { targetId: target.id },
      );
    },
  };
}
