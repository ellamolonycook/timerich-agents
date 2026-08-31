import { describe, expect, it } from 'vitest';
import { ConfigurationError, REDACTED, ValidationError } from '@timerich/shared';
import {
  InMemoryOutreachLedger,
  PODCAST_OUTREACH_EMAIL_CONNECTOR_ID,
  PODCAST_OUTREACH_PROSPECT_CONNECTOR_ID,
  PodcastOutreachAgent,
  type ComposedOutreach,
  type OutreachComposer,
  type PodcastTarget,
} from '../src/index.js';
import { createHarness, stubComposer, target } from './harness.js';

/** Composer that records every target it was asked to draft for. */
function countingComposer(): OutreachComposer & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async compose(candidate: PodcastTarget): Promise<ComposedOutreach | null> {
      calls.push(candidate.id);
      return {
        subject: `Guest idea for ${candidate.showName}`,
        body: 'A short pitch.',
        rationale: 'Audience overlap.',
      };
    },
  };
}

describe('stage 1: prospect intake', () => {
  it('pulls prospects from the source connector and normalises them', async () => {
    const h = createHarness({
      prospects: [
        { id: 'p1', show_name: 'Deep Work Weekly', email: 'kim@example.com', notes: 'Overlap.' },
        { id: 'p2', showName: 'Focus Hour', contactEmail: 'lee@example.com', notes: 'Overlap.' },
      ],
    });
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });

    const result = await agent.run(
      {
        campaignId: 'launch-2026',
        maxOutreachPerRun: 10,
        intake: {
          connectorId: PODCAST_OUTREACH_PROSPECT_CONNECTOR_ID,
          query: { campaignId: 'launch-2026' },
        },
      },
      h.context,
    );

    expect(result.output.intake).toEqual({ received: 2, accepted: 2, rejected: 0 });
    expect(result.output.queued).toHaveLength(2);
    expect(h.prospectSource.queries).toEqual([{ campaignId: 'launch-2026' }]);
    expect(h.connector.sent).toHaveLength(0);
  });

  it('combines inline targets with source records', async () => {
    const h = createHarness({
      prospects: [{ id: 'p1', showName: 'From Source', email: 'kim@example.com', notes: 'Fit.' }],
    });
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });

    const result = await agent.run(
      {
        campaignId: 'launch-2026',
        maxOutreachPerRun: 10,
        targets: [target()],
        intake: {
          connectorId: PODCAST_OUTREACH_PROSPECT_CONNECTOR_ID,
          query: { campaignId: 'launch-2026' },
        },
      },
      h.context,
    );

    expect(result.output.intake).toEqual({ received: 2, accepted: 2, rejected: 0 });
    expect(result.output.queued.map((entry) => entry.targetId).sort()).toEqual(['p1', 't1']);
  });

  it('records unusable source records as intake-invalid without failing the run', async () => {
    const h = createHarness({
      prospects: [
        { id: 'good', showName: 'Usable', email: 'kim@example.com', notes: 'Fit.' },
        { showName: 'No Id' },
        { id: 'no-show-name' },
      ],
    });
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });

    const result = await agent.run(
      {
        campaignId: 'c',
        maxOutreachPerRun: 10,
        intake: { connectorId: PODCAST_OUTREACH_PROSPECT_CONNECTOR_ID, query: { campaignId: 'c' } },
      },
      h.context,
    );

    expect(result.output.intake).toEqual({ received: 3, accepted: 1, rejected: 2 });
    expect(result.output.queued).toHaveLength(1);
    expect(
      result.output.skipped.filter((entry) => entry.reason === 'intake-invalid'),
    ).toHaveLength(2);
    expect(result.output.skipped.map((entry) => entry.targetId)).toContain('no-show-name');
  });

  it('redacts secret-shaped fields when logging a rejected source record', async () => {
    const h = createHarness({
      prospects: [{ id: 'leaky', apiKey: 'sk-live-must-not-leak', nested: { token: 'also-secret' } }],
    });
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });

    await agent.run(
      {
        campaignId: 'c',
        maxOutreachPerRun: 10,
        intake: { connectorId: PODCAST_OUTREACH_PROSPECT_CONNECTOR_ID, query: { campaignId: 'c' } },
      },
      h.context,
    );

    const rejection = h.sink.records.find(
      (record) => record.message === 'Prospect record rejected at intake',
    );
    expect(rejection).toBeDefined();
    expect(rejection?.fields).toMatchObject({
      record: { id: 'leaky', apiKey: REDACTED, nested: { token: REDACTED } },
    });
    expect(JSON.stringify(h.sink.records)).not.toContain('sk-live-must-not-leak');
    expect(JSON.stringify(h.sink.records)).not.toContain('also-secret');
  });

  it('refuses a prospect source that is not a data-source connector', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });

    // The email connector is outbound; the restricted reader will not hand it
    // over at all, which is itself the boundary doing its job.
    await expect(
      agent.run(
        {
          campaignId: 'c',
          maxOutreachPerRun: 5,
          intake: {
            connectorId: PODCAST_OUTREACH_EMAIL_CONNECTOR_ID,
            query: { campaignId: 'c' },
          },
        },
        h.context,
      ),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('refuses a connector registered under the wrong kind', async () => {
    const enrichment = {
      descriptor: {
        id: 'verifier',
        kind: 'enrichment' as const,
        displayName: 'Address verifier',
        requiredSecrets: [],
      },
      healthCheck: async () => ({ healthy: true, checkedAt: '2026-01-01T00:00:00.000Z' }),
      enrich: async () => undefined,
    };
    const h = createHarness({ extraConnectors: [enrichment] });
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });

    await expect(
      agent.run(
        {
          campaignId: 'c',
          maxOutreachPerRun: 5,
          intake: { connectorId: 'verifier', query: { campaignId: 'c' } },
        },
        h.context,
      ),
    ).rejects.toThrow(/not a prospect source/);
  });

  it('refuses a data-source connector that does not implement fetch', async () => {
    const malformed = {
      descriptor: {
        id: 'broken.source',
        kind: 'data-source' as const,
        displayName: 'Malformed source',
        requiredSecrets: [],
      },
      healthCheck: async () => ({ healthy: true, checkedAt: '2026-01-01T00:00:00.000Z' }),
    };
    const h = createHarness({ extraConnectors: [malformed] });
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });

    await expect(
      agent.run(
        {
          campaignId: 'c',
          maxOutreachPerRun: 5,
          intake: { connectorId: 'broken.source', query: { campaignId: 'c' } },
        },
        h.context,
      ),
    ).rejects.toThrow(/does not implement ProspectSourceConnector.fetch/);
  });

  it('refuses an unregistered prospect source', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });

    await expect(
      agent.run(
        {
          campaignId: 'c',
          maxOutreachPerRun: 5,
          intake: { connectorId: 'does.not.exist', query: { campaignId: 'c' } },
        },
        h.context,
      ),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});

describe('stage 2: screening and deduplication', () => {
  it('skips targets with no contact email', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });

    const result = await agent.run(
      {
        campaignId: 'c',
        maxOutreachPerRun: 10,
        targets: [{ id: 'no-email', showName: 'The Time Show' }],
      },
      h.context,
    );

    expect(result.output.queued).toHaveLength(0);
    expect(result.output.skipped[0]).toEqual({
      targetId: 'no-email',
      reason: 'missing-contact-email',
    });
  });

  it('skips a malformed contact email', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });

    const result = await agent.run(
      { campaignId: 'c', maxOutreachPerRun: 10, targets: [target({ contactEmail: 'nope' })] },
      h.context,
    );

    expect(result.output.skipped[0]?.reason).toBe('invalid-contact-email');
  });

  it('honours the campaign suppression list for addresses and domains', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });

    const result = await agent.run(
      {
        campaignId: 'c',
        maxOutreachPerRun: 10,
        suppress: ['kim@example.com', 'blocked.io'],
        targets: [
          target({ id: 'a', contactEmail: 'kim@example.com' }),
          target({ id: 'b', contactEmail: 'anyone@blocked.io' }),
          target({ id: 'c', contactEmail: 'ok@allowed.com' }),
        ],
      },
      h.context,
    );

    expect(result.output.queued.map((entry) => entry.targetId)).toEqual(['c']);
    expect(result.output.skippedByReason['suppressed']).toBe(2);
  });

  it('de-duplicates by id and by email within a run', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });

    const result = await agent.run(
      {
        campaignId: 'c',
        maxOutreachPerRun: 10,
        targets: [target(), target(), target({ id: 't3', contactEmail: 'SAM@Example.com ' })],
      },
      h.context,
    );

    expect(result.output.queued).toHaveLength(1);
    expect(result.output.skipped.map((entry) => entry.reason)).toEqual([
      'duplicate-target',
      'duplicate-target',
    ]);
  });

  it('de-duplicates across runs through the outreach ledger', async () => {
    const ledger = new InMemoryOutreachLedger();
    const composer = stubComposer();

    const first = createHarness();
    const firstResult = await new PodcastOutreachAgent({ composer, ledger }).run(
      { campaignId: 'run-one', maxOutreachPerRun: 10, targets: [target()] },
      first.context,
    );
    expect(firstResult.output.queued).toHaveLength(1);
    expect(ledger.entries()).toHaveLength(1);

    // A completely fresh runtime, same ledger: the prospect is remembered.
    const second = createHarness();
    const secondResult = await new PodcastOutreachAgent({ composer, ledger }).run(
      { campaignId: 'run-two', maxOutreachPerRun: 10, targets: [target()] },
      second.context,
    );

    expect(secondResult.output.queued).toHaveLength(0);
    expect(secondResult.output.skipped[0]?.reason).toBe('already-contacted');
    expect(await second.queue.listPending()).toHaveLength(0);
  });

  it('recognises a previously contacted host under a new prospect id', async () => {
    const ledger = new InMemoryOutreachLedger();
    const composer = stubComposer();

    const first = createHarness();
    await new PodcastOutreachAgent({ composer, ledger }).run(
      { campaignId: 'run-one', maxOutreachPerRun: 10, targets: [target()] },
      first.context,
    );

    const second = createHarness();
    const result = await new PodcastOutreachAgent({ composer, ledger }).run(
      { campaignId: 'run-two', maxOutreachPerRun: 10, targets: [target({ id: 'renamed' })] },
      second.context,
    );

    expect(result.output.skipped[0]?.reason).toBe('already-contacted');
  });
});

describe('stage 3: rate limiting', () => {
  it('stops at the outreach budget and does not compose beyond it', async () => {
    const h = createHarness({ maxOutreachPerInterval: 1 });
    const composer = countingComposer();
    const agent = new PodcastOutreachAgent({ composer, ledger: h.ledger });

    const result = await agent.run(
      {
        campaignId: 'c',
        maxOutreachPerRun: 10,
        targets: [
          target({ id: 'a', contactEmail: 'a@example.com' }),
          target({ id: 'b', contactEmail: 'b@example.com' }),
          target({ id: 'c', contactEmail: 'c@example.com' }),
        ],
      },
      h.context,
    );

    expect(result.output.queued).toHaveLength(1);
    expect(result.output.skippedByReason['rate-limited']).toBe(2);
    // The pre-check saved two composer calls.
    expect(composer.calls).toEqual(['a']);
  });

  it('refills the budget as time passes', async () => {
    const h = createHarness({ maxOutreachPerInterval: 1 });
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });

    const first = await agent.run(
      { campaignId: 'c', maxOutreachPerRun: 10, targets: [target({ id: 'a' })] },
      h.context,
    );
    expect(first.output.queued).toHaveLength(1);

    const limited = await agent.run(
      {
        campaignId: 'c',
        maxOutreachPerRun: 10,
        targets: [target({ id: 'b', contactEmail: 'b@example.com' })],
      },
      h.context,
    );
    expect(limited.output.skipped[0]?.reason).toBe('rate-limited');

    h.clock.advance(60 * 60 * 1000);

    const afterRefill = await agent.run(
      {
        campaignId: 'c',
        maxOutreachPerRun: 10,
        targets: [target({ id: 'c', contactEmail: 'c@example.com' })],
      },
      h.context,
    );
    expect(afterRefill.output.queued).toHaveLength(1);
  });

  it('stops at maxOutreachPerRun even when the budget allows more', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });

    const result = await agent.run(
      {
        campaignId: 'c',
        maxOutreachPerRun: 1,
        targets: [
          target({ id: 'a', contactEmail: 'a@example.com' }),
          target({ id: 'b', contactEmail: 'b@example.com' }),
        ],
      },
      h.context,
    );

    expect(result.output.queued).toHaveLength(1);
    expect(result.output.skipped[0]?.reason).toBe('run-limit-reached');
  });
});

describe('stage 4: composition', () => {
  it('records a composer decline as a skip, not a failure', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });

    const result = await agent.run(
      {
        campaignId: 'c',
        maxOutreachPerRun: 5,
        targets: [target({ showName: 'Please skip me' })],
      },
      h.context,
    );

    expect(result.output.skipped[0]?.reason).toBe('composer-declined');
    expect(h.ledger.entries()).toHaveLength(0);
  });

  it('carries the composed draft and metadata onto the approval item', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });

    await agent.run(
      {
        campaignId: 'launch-2026',
        maxOutreachPerRun: 5,
        targets: [target({ website: 'https://example.com' })],
      },
      h.context,
    );

    const [item] = await h.queue.listPending();
    expect(item?.intent.message.subject).toBe('Guest idea for The Time Show');
    expect(item?.intent.message.to.address).toBe('sam@example.com');
    expect(item?.intent.reason).toBe('Covers time management for founders.');
    expect(item?.intent.message.metadata).toMatchObject({
      campaignId: 'launch-2026',
      showName: 'The Time Show',
      website: 'https://example.com',
    });
    expect(item?.intent.riskTags).toContain('cold-contact');
  });
});

describe('stage 5: approval submission', () => {
  it('queues every eligible draft and sends nothing', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });

    const result = await agent.run(
      {
        campaignId: 'launch-2026',
        maxOutreachPerRun: 10,
        targets: [target(), target({ id: 't2', contactEmail: 'kim@example.com' })],
      },
      h.context,
    );

    expect(result.output.queued).toHaveLength(2);
    expect(result.output.skipped).toHaveLength(0);
    expect(result.output.evaluated).toBe(2);
    expect(h.connector.sent).toHaveLength(0);
    expect(await h.queue.listPending()).toHaveLength(2);
    expect(result.approvalIds).toHaveLength(2);
  });

  it('records a guardrail denial as blocked and leaves the ledger untouched', async () => {
    const h = createHarness();
    const emptyBodyComposer: OutreachComposer = {
      async compose() {
        return { subject: 'Hello', body: '   ', rationale: 'Some reason.' };
      },
    };
    const agent = new PodcastOutreachAgent({ composer: emptyBodyComposer, ledger: h.ledger });

    const result = await agent.run(
      { campaignId: 'c', maxOutreachPerRun: 5, targets: [target()] },
      h.context,
    );

    expect(result.output.queued).toHaveLength(0);
    expect(result.output.skipped[0]).toMatchObject({
      targetId: 't1',
      reason: 'guardrail-blocked',
      detail: 'outbound-completeness',
    });
    // Nothing was queued for a human, so the prospect stays eligible later.
    expect(h.ledger.entries()).toHaveLength(0);

    const blocked = await h.queue.list({ status: 'blocked' });
    expect(blocked).toHaveLength(1);
    expect(await h.queue.listPending()).toHaveLength(0);
  });

  it('writes one ledger entry per queued draft, keyed to its approval id', async () => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });

    const result = await agent.run(
      { campaignId: 'launch-2026', maxOutreachPerRun: 5, targets: [target()] },
      h.context,
    );

    const entry = await h.ledger.findByProspectId('t1');
    expect(entry).toMatchObject({
      prospectId: 't1',
      contactEmail: 'sam@example.com',
      campaignId: 'launch-2026',
      approvalId: result.output.queued[0]?.approvalId,
      queuedAt: '2026-01-01T00:00:00.000Z',
    });
  });
});

describe('input validation', () => {
  it.each([
    ['a blank campaignId', { campaignId: ' ', maxOutreachPerRun: 5, targets: [] }],
    ['a zero run limit', { campaignId: 'c', maxOutreachPerRun: 0, targets: [] }],
    ['a fractional run limit', { campaignId: 'c', maxOutreachPerRun: 1.5, targets: [] }],
    ['no prospect source at all', { campaignId: 'c', maxOutreachPerRun: 5 }],
  ])('rejects %s before touching the outbound gateway', async (_label, input) => {
    const h = createHarness();
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });

    await expect(agent.run(input, h.context)).rejects.toBeInstanceOf(ValidationError);
    expect(await h.queue.list()).toHaveLength(0);
  });
});

describe('run reporting', () => {
  it('summarises intake, queued work and skip reasons', async () => {
    const h = createHarness({ prospects: [{ showName: 'No Id' }] });
    const agent = new PodcastOutreachAgent({ composer: stubComposer(), ledger: h.ledger });

    const result = await agent.run(
      {
        campaignId: 'c',
        maxOutreachPerRun: 10,
        suppress: ['blocked.io'],
        targets: [
          target({ id: 'ok' }),
          target({ id: 'dupe' , contactEmail: 'sam@example.com' }),
          target({ id: 'blocked', contactEmail: 'x@blocked.io' }),
          { id: 'no-email', showName: 'No Email' },
        ],
        intake: { connectorId: PODCAST_OUTREACH_PROSPECT_CONNECTOR_ID, query: { campaignId: 'c' } },
      },
      h.context,
    );

    expect(result.output.intake).toEqual({ received: 5, accepted: 4, rejected: 1 });
    expect(result.output.queued).toHaveLength(1);
    expect(result.output.skippedByReason).toEqual({
      'intake-invalid': 1,
      'duplicate-target': 1,
      suppressed: 1,
      'missing-contact-email': 1,
    });
    expect(result.runId).toBe('run_1');
    expect(result.startedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});
