import type { SecretRef } from '../auth/types.js';
import type { ApprovalToken } from '../approval-queue/token.js';

export type ConnectorKind = 'outbound' | 'data-source' | 'enrichment';

export type OutboundChannel = 'email' | 'linkedin' | 'whatsapp' | 'sms' | 'webhook';

/**
 * Static description of a connector. Safe to log and to embed in an agent
 * manifest - it names the secrets it needs but never holds their values.
 */
export interface ConnectorDescriptor {
  readonly id: string;
  readonly kind: ConnectorKind;
  readonly displayName: string;
  readonly requiredSecrets: readonly SecretRef[];
}

export interface ConnectorHealth {
  readonly healthy: boolean;
  readonly checkedAt: string;
  readonly detail?: string;
}

export interface Connector {
  readonly descriptor: ConnectorDescriptor;
  healthCheck(): Promise<ConnectorHealth>;
}

export interface Recipient {
  /** Stable id in our own system, when we have one. */
  readonly id?: string;
  /** Channel-specific address: email address, profile URL, phone number. */
  readonly address: string;
  readonly displayName?: string;
}

export interface OutboundMessage {
  readonly channel: OutboundChannel;
  readonly to: Recipient;
  readonly subject?: string;
  readonly body: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface DeliveryReceipt {
  readonly connectorId: string;
  readonly channel: OutboundChannel;
  readonly acceptedAt: string;
  readonly providerMessageId?: string;
  /** True when the connector ran in dry-run mode and sent nothing. */
  readonly dryRun: boolean;
}

/**
 * A connector that can reach a human outside the company.
 *
 * `send` demands an `ApprovalToken`, which only the approval queue can mint.
 * This is what makes approval-before-send a compile-time guarantee rather than
 * a convention an agent could forget.
 */
export interface OutboundConnector extends Connector {
  readonly channel: OutboundChannel;
  send(message: OutboundMessage, approval: ApprovalToken): Promise<DeliveryReceipt>;
}

/** Read-only connector, e.g. a CRM or podcast database. Needs no approval. */
export interface DataSourceConnector<TQuery, TRecord> extends Connector {
  fetch(query: TQuery): Promise<readonly TRecord[]>;
}

/** Enriches a record in place, e.g. email verification. Needs no approval. */
export interface EnrichmentConnector<TInput, TOutput> extends Connector {
  enrich(input: TInput): Promise<TOutput>;
}

export function isOutboundConnector(connector: Connector): connector is OutboundConnector {
  return connector.descriptor.kind === 'outbound';
}
