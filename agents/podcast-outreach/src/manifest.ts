import { secretRef, type AgentManifest } from '@timerich/shared';

export const PODCAST_OUTREACH_AGENT_ID = 'podcast-outreach';

/**
 * Connector id the agent names on every intent. It is resolved to a concrete
 * connector at dispatch time, on the operator side - the agent never holds it.
 */
export const PODCAST_OUTREACH_EMAIL_CONNECTOR_ID = 'email.primary';

export const podcastOutreachManifest: AgentManifest = {
  id: PODCAST_OUTREACH_AGENT_ID,
  name: 'Podcast Outreach',
  version: '0.1.0',
  description:
    'Turns researched podcast targets into reviewable outreach drafts and files them for human approval.',
  responsibilities: [
    'Accept a campaign and a list of researched podcast targets.',
    'Screen targets for contactability and de-duplicate within a run.',
    'Ask the composer port for a draft pitch per eligible target.',
    'Submit each draft to the approval queue with a stated reason for the reviewer.',
    'Report exactly what was queued and what was skipped, and why.',
  ],
  boundaries: [
    'Never sends an email or message. It can only create approval items.',
    'Never resolves or dispatches an approval item; that is operator-side.',
    'Never sources or researches podcasts itself; targets arrive as input.',
    'Never bypasses or reconfigures the guardrail chain it is given.',
    'Never reads or writes anything in the timerich-brain repository.',
  ],
  connectors: [
    {
      connectorId: PODCAST_OUTREACH_EMAIL_CONNECTOR_ID,
      kind: 'outbound',
      purpose: 'Delivers approved podcast pitches. Invoked only by the dispatcher.',
      requiredSecrets: [
        secretRef('EMAIL_PROVIDER_API_KEY', 'Credential for the outbound email provider.'),
      ],
    },
  ],
  outbound: {
    channels: ['email'],
    approvalRequired: true,
  },
};
