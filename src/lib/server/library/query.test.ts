import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '$lib/server/db/client';
import type { ProseBlockData } from '$lib/types/publication';
import {
  comicCompletionPercent,
  listCustomerLibrary,
  proseCompletionPercent
} from './query';

function databaseReturning(...results: unknown[][]): Database {
  return {
    select: vi.fn(() => {
      const value = results.shift() ?? [];
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy']) {
        chain[method] = vi.fn(() => chain);
      }
      chain.then = (resolve: (rows: unknown[]) => unknown, reject: (cause: unknown) => unknown) =>
        Promise.resolve(value).then(resolve, reject);
      return chain;
    })
  } as unknown as Database;
}

const paragraph = (text: string): ProseBlockData => ({
  kind: 'paragraph',
  fragments: [{ text, marks: [] }]
});

describe('customer library query', () => {
  it('calculates bounded semantic prose and comic completion', () => {
    const firstBlockId = randomUUID();
    const secondBlockId = randomUUID();
    expect(
      proseCompletionPercent(
        [
          { id: firstBlockId, content: paragraph('abcd') },
          { id: secondBlockId, content: paragraph('123456') }
        ],
        { blockId: secondBlockId, offset: 3 }
      )
    ).toBe(75);
    expect(
      proseCompletionPercent(
        [{ id: firstBlockId, content: paragraph('abcd') }],
        { blockId: firstBlockId, offset: 10_000 }
      )
    ).toBe(100);
    const firstPageId = randomUUID();
    const secondPageId = randomUUID();
    expect(
      comicCompletionPercent(
        [
          { id: firstPageId, panelOrdinals: [] },
          { id: secondPageId, panelOrdinals: [0, 1] }
        ],
        { pageId: secondPageId, panelOrdinal: 0 }
      )
    ).toBe(75);
  });

  it('maps safe available and unavailable entries with constant query count', async () => {
    const userId = randomUUID();
    const proseTitleId = randomUUID();
    const proseRevisionId = randomUUID();
    const prosePresentationId = randomUUID();
    const comicTitleId = randomUUID();
    const comicRevisionId = randomUUID();
    const comicPresentationId = randomUUID();
    const unavailableTitleId = randomUUID();
    const blockId = randomUUID();
    const pageId = randomUUID();
    const database = databaseReturning(
      [
        {
          titleId: proseTitleId,
          slug: 'alpha-prose',
          title: 'Alpha Prose',
          creatorName: 'Author',
          format: 'prose',
          activeRevisionId: proseRevisionId,
          coverStorageKey: 'covers/private-alpha',
          coverMediaType: 'image/webp',
          coverChecksumSha256: 'a'.repeat(64),
          coverByteSize: 100,
          coverWidth: 10,
          coverHeight: 20,
          revisionId: proseRevisionId,
          presentationId: prosePresentationId,
          originalStorageKey: 'originals/private-alpha',
          originalChecksumSha256: 'b'.repeat(64),
          originalMimeType: 'application/epub+zip',
          originalByteSize: 200,
          originalFilename: 'alpha.epub',
          progressFormat: 'prose',
          progressBlockId: blockId,
          progressOffset: 2,
          progressPageId: null,
          progressPanelOrdinal: null
        },
        {
          titleId: comicTitleId,
          slug: 'beta-comic',
          title: 'Beta Comic',
          creatorName: 'Artist',
          format: 'comic',
          activeRevisionId: comicRevisionId,
          coverStorageKey: null,
          coverMediaType: null,
          coverChecksumSha256: null,
          coverByteSize: null,
          coverWidth: null,
          coverHeight: null,
          revisionId: comicRevisionId,
          presentationId: comicPresentationId,
          originalStorageKey: 'originals/private-beta',
          originalChecksumSha256: 'c'.repeat(64),
          originalMimeType: 'application/vnd.comicbook+zip',
          originalByteSize: 300,
          originalFilename: 'beta.cbz',
          progressFormat: 'comic',
          progressBlockId: null,
          progressOffset: null,
          progressPageId: pageId,
          progressPanelOrdinal: null
        },
        {
          titleId: unavailableTitleId,
          slug: 'zeta-unavailable',
          title: 'Zeta Unavailable',
          creatorName: 'Author',
          format: 'prose',
          activeRevisionId: null,
          coverStorageKey: null,
          coverMediaType: null,
          coverChecksumSha256: null,
          coverByteSize: null,
          coverWidth: null,
          coverHeight: null,
          revisionId: null,
          presentationId: null,
          originalStorageKey: null,
          originalChecksumSha256: null,
          originalMimeType: null,
          originalByteSize: null,
          originalFilename: null,
          progressFormat: null,
          progressBlockId: null,
          progressOffset: null,
          progressPageId: null,
          progressPanelOrdinal: null
        }
      ],
      [{ revisionId: proseRevisionId, id: blockId, content: paragraph('abcd') }],
      [{ revisionId: comicRevisionId, id: pageId, ordinal: 1, panelOrdinal: null }]
    );

    await expect(listCustomerLibrary(database, userId)).resolves.toEqual([
      {
        titleId: proseTitleId,
        slug: 'alpha-prose',
        title: 'Alpha Prose',
        creatorName: 'Author',
        format: 'prose',
        coverUrl: `/media/covers/${proseTitleId}/${'a'.repeat(64)}`,
        availability: 'available',
        activeRevisionId: proseRevisionId,
        downloadFormat: 'epub',
        progressPercent: 50,
        readUrl: `/read/${proseTitleId}`,
        resumeUrl: `/read/${proseTitleId}?resume=1`,
        downloadUrl: `/library/${proseTitleId}/download`
      },
      {
        titleId: comicTitleId,
        slug: 'beta-comic',
        title: 'Beta Comic',
        creatorName: 'Artist',
        format: 'comic',
        coverUrl: null,
        availability: 'available',
        activeRevisionId: comicRevisionId,
        downloadFormat: 'cbz',
        progressPercent: 0,
        readUrl: `/read/${comicTitleId}`,
        resumeUrl: `/read/${comicTitleId}?resume=1`,
        downloadUrl: `/library/${comicTitleId}/download`
      },
      {
        titleId: unavailableTitleId,
        slug: 'zeta-unavailable',
        title: 'Zeta Unavailable',
        creatorName: 'Author',
        format: 'prose',
        coverUrl: null,
        availability: 'temporarily_unavailable',
        activeRevisionId: null,
        downloadFormat: null,
        progressPercent: null,
        readUrl: null,
        resumeUrl: null,
        downloadUrl: null
      }
    ]);
    expect(database.select).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(await listCustomerLibrary(databaseReturning([], [], []), userId)))
      .not.toMatch(/userId|entitlementId|storageKey|presentationId/iu);
  });
});
