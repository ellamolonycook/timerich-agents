import { secretRef, type AgentManifest } from '@timerich/shared';

export const PODCAST_OUTREACH_AGENT_ID = 'podcast-outreach';

/**
 * Connector id the agent names on every intent. It is resolved to a concrete
 * connector at dispatch time, on the operator side - the agent never holds it.
 */
export const PODCAST_OUTREACH_EMAIL_CONNECTOR_ID = 'email.primary';

/**
 * Read-only source of podcast prospects. Resolved through the agent's
 * connector reader during intake; sends nothing, so it needs no approval.
 */
export const PODCAST_OUTREACH_PROSPECT_CONNECTOR_ID = 'podcast.prospects';

export const podcastOutreachManifest: AgentManifest = {
  id: PODCAST_OUTREACH_AGENT_ID,
  name: 'Podcast Outreach',
  version: '0.2.0',
  description:
    'Takes in podcast prospects, screens and de-duplicates them, composes pitch drafts, and files each one for human approval.',
  responsibilities: [
    'Take in prospects from inline input and/or a read-only prospect source connector.',
    'Normalise raw source records into typed targets, rejecting unusable ones.',
    'Screen for contactability, address validity, and campaign suppression.',
    'De-duplicate within the run and against the cross-run outreach ledger.',
    'Respect the outreach rate limit before spending effort on composition.',
    'Ask the composer port for a draft pitch per eligible target.',
    'Submit each draft to the approval queue with a stated reason for the reviewer.',
    'Report exactly what was queued and what was skipped, and why.',
  ],
  boundaries: [
    'Never sends an email or message. It can only create approval items.',
    'Never resolves or dispatches an approval item; that is operator-side.',
    'Never researches or scores podcasts itself; prospects arrive from input or a source connector.',
    'Never bypasses or reconfigures the guardrail chain it is given.',
    'Never writes to the outreach ledger for a prospect it did not queue.',
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
    {
      connectorId: PODCAST_OUTREACH_PROSPECT_CONNECTOR_ID,
      kind: 'data-source',
      purpose: 'Supplies raw podcast prospect records for intake. Read-only.',
      requiredSecrets: [
        secretRef(
          'PODCAST_PROSPECT_SOURCE_API_KEY',
          'Credential for the podcast prospect source. Not required by the in-memory source.',
        ),
      ],
    },
  ],
  outbound: {
    channels: ['email'],
    approvalRequired: true,
  },
};
