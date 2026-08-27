import type { AgentManifest } from '@timerich/shared';

export const SALLY_AGENT_ID = 'sally';

/**
 * Placeholder manifest. Responsibilities, connectors and outbound channels are
 * defined in timerich-brain and land here when that spec is agreed.
 *
 * The one thing already fixed is the approval boundary: like every Time Rich
 * agent, this one will queue outbound work for review rather than sending it.
 */
export const sallyManifest: AgentManifest = {
  id: SALLY_AGENT_ID,
  name: 'Sally',
  version: '0.0.0',
  description: 'Placeholder for the Sally agent.',
  responsibilities: ['Not yet specified. See timerich-brain for the design spec.'],
  boundaries: [
    'Never sends externally without an approval item that a human has approved.',
    'Never bypasses or reconfigures the guardrail chain it is given.',
    'Never reads or writes anything in the timerich-brain repository.',
  ],
  connectors: [],
  outbound: {
    channels: [],
    approvalRequired: true,
  },
};
