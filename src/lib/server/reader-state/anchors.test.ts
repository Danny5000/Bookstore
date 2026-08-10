import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseExecutor } from '$lib/server/db/transaction';
import { InvalidReaderLocationError } from './errors';
import { validateReaderLocation } from './anchors';

function databaseReturning(...results: unknown[][]): DatabaseExecutor {
  return {
    select: vi.fn(() => {
      const value = results.shift() ?? [];
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'innerJoin', 'where', 'limit']) {
        chain[method] = vi.fn(() => chain);
      }
      chain.then = (resolve: (rows: unknown[]) => unknown, reject: (cause: unknown) => unknown) =>
        Promise.resolve(value).then(resolve, reject);
      return chain;
    })
  } as unknown as DatabaseExecutor;
}

const titleId = randomUUID();
const revisionId = randomUUID();
const presentationId = randomUUID();
const blockId = randomUUID();
const pageId = randomUUID();
const presentation = {
  id: presentationId,
  state: 'published' as const,
  guidedViewEnabled: true
};

describe('reader-state anchor validation', () => {
  it.each([0, 5])('accepts prose offset %s at an exact active block endpoint', async (offset) => {
    await expect(
      validateReaderLocation(databaseReturning([{
        id: blockId,
        content: { kind: 'paragraph', fragments: [{ text: 'hello', marks: [] }] }
      }]), {
        titleId,
        revisionId,
        format: 'prose',
        presentation,
        location: { format: 'prose', blockId, offset }
      })
    ).resolves.toEqual({ format: 'prose', blockId, offset });
  });

  it.each([
    { location: { format: 'prose' as const, blockId, offset: -1 }, rows: [] },
    { location: { format: 'prose' as const, blockId, offset: 6 }, rows: [{
      id: blockId,
      content: { kind: 'paragraph', fragments: [{ text: 'hello', marks: [] }] }
    }] },
    { location: { format: 'comic' as const, pageId, panelOrdinal: null }, rows: [] },
    { location: { format: 'prose' as const, blockId: randomUUID(), offset: 0 }, rows: [] }
  ])('rejects invalid, mismatched, or missing prose anchors uniformly', async ({ location, rows }) => {
    const failure = validateReaderLocation(databaseReturning(rows), {
      titleId,
      revisionId,
      format: 'prose',
      presentation,
      location
    });
    await expect(failure).rejects.toBeInstanceOf(InvalidReaderLocationError);
    await expect(failure).rejects.toMatchObject({ code: 'invalid_reader_location' });
  });

  it('accepts a whole comic page and a real published guided panel', async () => {
    await expect(
      validateReaderLocation(databaseReturning([{ id: pageId }]), {
        titleId,
        revisionId,
        format: 'comic',
        presentation,
        location: { format: 'comic', pageId, panelOrdinal: null }
      })
    ).resolves.toEqual({ format: 'comic', pageId, panelOrdinal: null });
    await expect(
      validateReaderLocation(databaseReturning([{ id: pageId }], [{ ordinal: 2 }]), {
        titleId,
        revisionId,
        format: 'comic',
        presentation,
        location: { format: 'comic', pageId, panelOrdinal: 2 }
      })
    ).resolves.toEqual({ format: 'comic', pageId, panelOrdinal: 2 });
  });

  it.each([
    { guidedViewEnabled: false, panelRows: [{ ordinal: 2 }] },
    { guidedViewEnabled: true, panelRows: [] }
  ])('rejects unavailable or draft-only panel anchors', async ({ guidedViewEnabled, panelRows }) => {
    await expect(
      validateReaderLocation(databaseReturning([{ id: pageId }], panelRows), {
        titleId,
        revisionId,
        format: 'comic',
        presentation: { ...presentation, guidedViewEnabled },
        location: { format: 'comic', pageId, panelOrdinal: 2 }
      })
    ).rejects.toBeInstanceOf(InvalidReaderLocationError);
  });
});
