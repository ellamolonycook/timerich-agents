import { ValidationError, type ConnectorHealth } from '@timerich/shared';
import type {
  PodcastTarget,
  ProspectQuery,
  ProspectSourceConnector,
  RawProspect,
} from './types.js';

export type ProspectNormalization =
  | { readonly ok: true; readonly target: PodcastTarget }
  | { readonly ok: false; readonly reason: string };

/**
 * Field aliases accepted from a source record. Providers disagree about case
 * conventions; normalising here keeps that mess out of the workflow.
 */
const FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = {
  id: ['id', 'prospect_id', 'prospectId'],
  showName: ['showName', 'show_name', 'show', 'podcast_name'],
  hostName: ['hostName', 'host_name', 'host'],
  contactEmail: ['contactEmail', 'contact_email', 'email'],
  website: ['website', 'url', 'site'],
  relevanceNotes: ['relevanceNotes', 'relevance_notes', 'notes'],
};

/** Reads the first alias that holds a non-empty string. */
function readField(raw: RawProspect, field: keyof typeof FIELD_ALIASES): string | undefined {
  for (const alias of FIELD_ALIASES[field] ?? []) {
    const value = raw[alias];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/**
 * Turns one raw source record into a `PodcastTarget`.
 *
 * A record without an id or a show name is unusable: it cannot be de-duplicated
 * and a reviewer could not tell what they were approving. Those are rejected
 * rather than guessed at.
 */
export function normalizeProspect(raw: RawProspect): ProspectNormalization {
  const id = readField(raw, 'id');
  if (id === undefined) return { ok: false, reason: 'missing id' };

  const showName = readField(raw, 'showName');
  if (showName === undefined) return { ok: false, reason: 'missing showName' };

  const hostName = readField(raw, 'hostName');
  const contactEmail = readField(raw, 'contactEmail');
  const website = readField(raw, 'website');
  const relevanceNotes = readField(raw, 'relevanceNotes');

  return {
    ok: true,
    target: {
      id,
      showName,
      ...(hostName === undefined ? {} : { hostName }),
      ...(contactEmail === undefined ? {} : { contactEmail }),
      ...(website === undefined ? {} : { website }),
      ...(relevanceNotes === undefined ? {} : { relevanceNotes }),
    },
  };
}

export interface InMemoryProspectSourceOptions {
  readonly connectorId?: string;
  readonly displayName?: string;
}

/**
 * Safe stand-in for a real prospect provider. It performs no I/O, so the whole
 * workflow runs end to end in development and tests without a network or a
 * credential.
 *
 * A real provider replaces this by implementing the same
 * `ProspectSourceConnector` port and registering under the same connector id.
 */
export class InMemoryProspectSource implements ProspectSourceConnector {
  readonly #records: readonly RawProspect[];
  readonly descriptor;

  /** Queries this source has served, for assertions in tests. */
  readonly queries: ProspectQuery[] = [];

  constructor(records: readonly RawProspect[], options: InMemoryProspectSourceOptions = {}) {
    this.#records = records;
    this.descriptor = {
      id: options.connectorId ?? 'podcast.prospects',
      kind: 'data-source' as const,
      displayName: options.displayName ?? 'In-memory podcast prospect source',
      requiredSecrets: [],
    };
  }

  async healthCheck(): Promise<ConnectorHealth> {
    return { healthy: true, checkedAt: new Date(0).toISOString() };
  }

  async fetch(query: ProspectQuery): Promise<readonly RawProspect[]> {
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1)) {
      throw new ValidationError('ProspectQuery.limit must be a positive integer', {
        limit: query.limit,
      });
    }
    this.queries.push(query);

    // A record tagged with a campaign belongs only to that campaign; untagged
    // records are shared across campaigns.
    const scoped = this.#records.filter((record) => {
      const campaignId = record['campaignId'];
      return typeof campaignId !== 'string' || campaignId === query.campaignId;
    });

    return query.limit === undefined ? scoped : scoped.slice(0, query.limit);
  }
}
