import { ConfigurationError } from '../core/errors.js';
import type { Connector, OutboundConnector } from './types.js';
import { isOutboundConnector } from './types.js';

/**
 * Read-only view of the registry, used by operator-side code (notably
 * `ApprovalDispatcher`). Callers resolve; they never register.
 */
export interface ConnectorReader {
  get(id: string): Connector | undefined;
  require(id: string): Connector;
  requireOutbound(id: string): OutboundConnector;
  list(): readonly Connector[];
}

/**
 * Composition-root owned registry. Wiring code registers concrete connectors
 * once at startup and passes the reader into each agent context.
 */
/**
 * The narrower view handed to agents. It has no `requireOutbound`, and its
 * `get`/`require` refuse to hand back an outbound connector at all.
 *
 * This is the second half of the approval boundary. The token brand stops an
 * agent obtaining an `ApprovalToken`; this stops it obtaining anything with a
 * `send` method to call. Subverting the boundary would require both an
 * explicit type assertion and a connector the agent cannot reach.
 */
export type AgentConnectorReader = Omit<ConnectorReader, 'requireOutbound'>;

/**
 * Wraps a reader so outbound connectors are invisible to it. Used by
 * `createAgentRuntime`; agents never see the unrestricted reader.
 */
export function restrictOutboundAccess(reader: ConnectorReader): AgentConnectorReader {
  const guard = (connector: Connector): Connector => {
    if (isOutboundConnector(connector)) {
      throw new ConfigurationError(
        `Connector '${connector.descriptor.id}' is outbound and is not reachable from an agent; ` +
          'outbound delivery happens on the operator side, after approval',
        { connectorId: connector.descriptor.id },
      );
    }
    return connector;
  };

  return {
    get: (id) => {
      const connector = reader.get(id);
      return connector === undefined ? undefined : guard(connector);
    },
    require: (id) => guard(reader.require(id)),
    list: () => reader.list().filter((connector) => !isOutboundConnector(connector)),
  };
}

export class ConnectorRegistry implements ConnectorReader {
  readonly #connectors = new Map<string, Connector>();

  register(connector: Connector): this {
    const { id } = connector.descriptor;
    if (this.#connectors.has(id)) {
      throw new ConfigurationError(`Connector '${id}' is already registered`, { connectorId: id });
    }
    this.#connectors.set(id, connector);
    return this;
  }

  get(id: string): Connector | undefined {
    return this.#connectors.get(id);
  }

  require(id: string): Connector {
    const connector = this.#connectors.get(id);
    if (connector === undefined) {
      throw new ConfigurationError(`Connector '${id}' is not registered`, { connectorId: id });
    }
    return connector;
  }

  requireOutbound(id: string): OutboundConnector {
    const connector = this.require(id);
    if (!isOutboundConnector(connector)) {
      throw new ConfigurationError(`Connector '${id}' is not an outbound connector`, {
        connectorId: id,
        kind: connector.descriptor.kind,
      });
    }
    return connector;
  }

  list(): readonly Connector[] {
    return [...this.#connectors.values()];
  }

  /** Narrow the registry to a reader so agents cannot mutate it. */
  asReader(): ConnectorReader {
    return {
      get: (id) => this.get(id),
      require: (id) => this.require(id),
      requireOutbound: (id) => this.requireOutbound(id),
      list: () => this.list(),
    };
  }
}
