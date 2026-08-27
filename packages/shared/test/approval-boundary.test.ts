import { describe, expect, it } from 'vitest';
import {
  ApprovalDispatcher,
  ApprovalRequiredError,
  ApprovalStateError,
  ConfigurationError,
  ConnectorRegistry,
  GuardrailChain,
  outboundCompletenessGuardrail,
  restrictOutboundAccess,
} from '../src/index.js';
import { START, anIntent, createHarness } from './support.js';

describe('approval boundary', () => {
  it('queues an intent as pending and sends nothing', async () => {
    const h = createHarness();

    const submission = await h.context.outbound.submit(anIntent());

    expect(submission.status).toBe('pending-approval');
    expect(h.connector.sent).toHaveLength(0);
    const item = await h.queue.require(submission.approvalId);
    expect(item.status).toBe('pending');
  });

  it('refuses to dispatch an item that is still pending', async () => {
    const h = createHarness();
    const submission = await h.context.outbound.submit(anIntent());
    const dispatcher = new ApprovalDispatcher({
      queue: h.queue,
      connectors: h.registry.asReader(),
      logger: h.context.logger,
    });

    await expect(dispatcher.dispatch(submission.approvalId)).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    );
    expect(h.connector.sent).toHaveLength(0);
  });

  it('refuses to dispatch a rejected item', async () => {
    const h = createHarness();
    const submission = await h.context.outbound.submit(anIntent());
    await h.queue.reject(submission.approvalId, { decidedBy: 'ella', note: 'Off-brand' });
    const dispatcher = new ApprovalDispatcher({
      queue: h.queue,
      connectors: h.registry.asReader(),
      logger: h.context.logger,
    });

    await expect(dispatcher.dispatch(submission.approvalId)).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    );
    expect(h.connector.sent).toHaveLength(0);
  });

  it('sends only after a human approves, carrying the approval token', async () => {
    const h = createHarness();
    const submission = await h.context.outbound.submit(anIntent());
    await h.queue.approve(submission.approvalId, { decidedBy: 'ella' });
    const dispatcher = new ApprovalDispatcher({
      queue: h.queue,
      connectors: h.registry.asReader(),
      logger: h.context.logger,
    });

    const result = await dispatcher.dispatch(submission.approvalId);

    expect(result.status).toBe('dispatched');
    expect(h.connector.sent).toHaveLength(1);
    expect(h.connector.sent[0]?.approval.approvalId).toBe(submission.approvalId);
    expect(h.connector.sent[0]?.approval.decidedBy).toBe('ella');
    const item = await h.queue.require(submission.approvalId);
    expect(item.status).toBe('dispatched');
  });

  it('marks the item failed when the connector throws, and does not retry silently', async () => {
    const h = createHarness();
    const submission = await h.context.outbound.submit(anIntent());
    await h.queue.approve(submission.approvalId, { decidedBy: 'ella' });
    h.connector.failWith = new Error('provider rejected the message');
    const dispatcher = new ApprovalDispatcher({
      queue: h.queue,
      connectors: h.registry.asReader(),
      logger: h.context.logger,
    });

    const result = await dispatcher.dispatch(submission.approvalId);

    expect(result.status).toBe('failed');
    const item = await h.queue.require(submission.approvalId);
    expect(item.status).toBe('failed');
    expect(item.failure).toContain('provider rejected');
  });

  it('cannot dispatch the same approved item twice', async () => {
    const h = createHarness();
    const submission = await h.context.outbound.submit(anIntent());
    await h.queue.approve(submission.approvalId, { decidedBy: 'ella' });
    const dispatcher = new ApprovalDispatcher({
      queue: h.queue,
      connectors: h.registry.asReader(),
      logger: h.context.logger,
    });

    await dispatcher.dispatch(submission.approvalId);
    await expect(dispatcher.dispatch(submission.approvalId)).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    );
    expect(h.connector.sent).toHaveLength(1);
  });

  it('stores a guardrail-denied intent as blocked so the reviewer can see it', async () => {
    const h = createHarness(new GuardrailChain([outboundCompletenessGuardrail()]));

    const submission = await h.context.outbound.submit(
      anIntent({
        message: {
          channel: 'email',
          to: { address: 'host@example.com' },
          body: '   ',
        },
      }),
    );

    expect(submission.status).toBe('blocked');
    const item = await h.queue.require(submission.approvalId);
    expect(item.status).toBe('blocked');
    expect(item.guardrail.denials.map((d) => d.guardrail)).toContain('outbound-completeness');
  });

  it('will not approve an item that guardrails blocked', async () => {
    const h = createHarness(new GuardrailChain([outboundCompletenessGuardrail()]));
    const submission = await h.context.outbound.submit(anIntent({ reason: '  ' }));

    await expect(
      h.queue.approve(submission.approvalId, { decidedBy: 'ella' }),
    ).rejects.toBeInstanceOf(ApprovalStateError);
  });

  it('does not let an agent reach an outbound connector at all', () => {
    const h = createHarness();

    expect(() => h.context.connectors.require('email.primary')).toThrow(ConfigurationError);
    expect(() => h.context.connectors.get('email.primary')).toThrow(ConfigurationError);
    expect(h.context.connectors.list()).toHaveLength(0);
    // The operator-side reader still resolves it.
    expect(h.registry.requireOutbound('email.primary')).toBe(h.connector);
  });

  it('hides outbound connectors from a restricted reader but keeps the rest', () => {
    const dataSource = {
      descriptor: {
        id: 'crm.read',
        kind: 'data-source' as const,
        displayName: 'CRM',
        requiredSecrets: [],
      },
      healthCheck: async () => ({ healthy: true, checkedAt: START.toISOString() }),
      fetch: async () => [],
    };
    const registry = new ConnectorRegistry().register(dataSource);
    const restricted = restrictOutboundAccess(registry.asReader());

    expect(restricted.require('crm.read')).toBe(dataSource);
    expect(restricted.list()).toHaveLength(1);
  });

  it('expires a pending item once its TTL elapses and refuses to decide it', async () => {
    const h = createHarness();
    const submission = await h.context.outbound.submit(anIntent());

    h.clock.advance(1441 * 60_000);

    const item = await h.queue.require(submission.approvalId);
    expect(item.status).toBe('expired');
    await expect(
      h.queue.approve(submission.approvalId, { decidedBy: 'ella' }),
    ).rejects.toBeInstanceOf(ApprovalStateError);
  });
});
