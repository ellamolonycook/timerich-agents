import { describe, expect, it } from 'vitest';
import { ValidationError } from '@timerich/shared';
import { InMemoryProspectSource, normalizeProspect } from '../src/index.js';

describe('normalizeProspect', () => {
  it('normalises a well-formed record and trims whitespace', () => {
    const result = normalizeProspect({
      id: '  p1 ',
      showName: ' The Time Show ',
      hostName: 'Sam',
      contactEmail: ' Sam@Example.com ',
      website: 'https://example.com',
      relevanceNotes: 'Covers founder productivity.',
    });

    expect(result).toEqual({
      ok: true,
      target: {
        id: 'p1',
        showName: 'The Time Show',
        hostName: 'Sam',
        contactEmail: 'Sam@Example.com',
        website: 'https://example.com',
        relevanceNotes: 'Covers founder productivity.',
      },
    });
  });

  it('accepts snake_case and common provider aliases', () => {
    const result = normalizeProspect({
      prospect_id: 'p2',
      show_name: 'Deep Work Weekly',
      host_name: 'Kim',
      email: 'kim@example.com',
      url: 'https://deepwork.example',
      notes: 'Audience overlap.',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target).toEqual({
      id: 'p2',
      showName: 'Deep Work Weekly',
      hostName: 'Kim',
      contactEmail: 'kim@example.com',
      website: 'https://deepwork.example',
      relevanceNotes: 'Audience overlap.',
    });
  });

  it('omits optional fields rather than setting them undefined', () => {
    const result = normalizeProspect({ id: 'p3', showName: 'Minimal' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.target).sort()).toEqual(['id', 'showName']);
  });

  it.each([
    ['missing id', { showName: 'No Id' }, 'missing id'],
    ['blank id', { id: '   ', showName: 'Blank Id' }, 'missing id'],
    ['missing showName', { id: 'p4' }, 'missing showName'],
    ['non-string id', { id: 42, showName: 'Numeric Id' }, 'missing id'],
  ])('rejects a record with %s', (_label, raw, reason) => {
    expect(normalizeProspect(raw)).toEqual({ ok: false, reason });
  });

  it('ignores provider-specific extra fields', () => {
    const result = normalizeProspect({
      id: 'p5',
      showName: 'Extras',
      downloadsPerEpisode: 12000,
      apiKey: 'should-be-ignored',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target).toEqual({ id: 'p5', showName: 'Extras' });
  });
});

describe('InMemoryProspectSource', () => {
  const records = [
    { id: 'a', showName: 'Shared Show' },
    { id: 'b', showName: 'Campaign Show', campaignId: 'launch-2026' },
    { id: 'c', showName: 'Other Campaign', campaignId: 'other' },
  ];

  it('declares itself as a read-only data source needing no secrets', () => {
    const source = new InMemoryProspectSource([]);
    expect(source.descriptor.kind).toBe('data-source');
    expect(source.descriptor.id).toBe('podcast.prospects');
    expect(source.descriptor.requiredSecrets).toEqual([]);
  });

  it('returns untagged records plus records for the requested campaign', async () => {
    const source = new InMemoryProspectSource(records);

    const fetched = await source.fetch({ campaignId: 'launch-2026' });

    expect(fetched.map((record) => record['id'])).toEqual(['a', 'b']);
    expect(source.queries).toEqual([{ campaignId: 'launch-2026' }]);
  });

  it('applies the query limit', async () => {
    const source = new InMemoryProspectSource(records);
    const fetched = await source.fetch({ campaignId: 'launch-2026', limit: 1 });
    expect(fetched).toHaveLength(1);
  });

  it('rejects a non-positive limit', async () => {
    const source = new InMemoryProspectSource(records);
    await expect(source.fetch({ campaignId: 'c', limit: 0 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('reports healthy without performing any I/O', async () => {
    await expect(new InMemoryProspectSource([]).healthCheck()).resolves.toMatchObject({
      healthy: true,
    });
  });
});
