import { NotImplementedError } from '@timerich/shared';
import type {
  ComposedOutreach,
  OutreachComposeContext,
  OutreachComposer,
  PodcastTarget,
} from './types.js';

/**
 * Default composer. Writing real pitch copy is a separate task, so the workflow
 * fails loudly rather than shipping a silent placeholder pitch.
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

export interface OutreachTemplate {
  subject(target: PodcastTarget, context: OutreachComposeContext): string;
  body(target: PodcastTarget, context: OutreachComposeContext): string;
  /** Defaults to the target's relevance notes. */
  rationale?(target: PodcastTarget, context: OutreachComposeContext): string;
  riskTags?: readonly string[];
}

/**
 * Deterministic composer driven by a caller-supplied template.
 *
 * It invents no copy of its own: the wording comes entirely from the template,
 * which is a campaign decision and belongs in `timerich-brain`. Its value is
 * that it makes the workflow runnable end to end without an LLM or a network,
 * and it declines rather than emitting a draft that a reviewer could not act on.
 */
export function templateOutreachComposer(template: OutreachTemplate): OutreachComposer {
  return {
    async compose(
      target: PodcastTarget,
      context: OutreachComposeContext,
    ): Promise<ComposedOutreach | null> {
      const subject = template.subject(target, context).trim();
      const body = template.body(target, context).trim();
      if (subject === '' || body === '') return null;

      const rationale = (
        template.rationale?.(target, context) ??
        target.relevanceNotes ??
        ''
      ).trim();
      // A reviewer needs to know why this show was chosen. Without that, the
      // draft is not reviewable, so decline instead of queuing a blank reason.
      if (rationale === '') return null;

      return {
        subject,
        body,
        rationale,
        ...(template.riskTags === undefined ? {} : { riskTags: template.riskTags }),
      };
    },
  };
}
