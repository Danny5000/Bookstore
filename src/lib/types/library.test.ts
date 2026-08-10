import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  libraryEntrySchema,
  readerBookmarkInputSchema,
  readerInitialStateSchema,
  readerLocationSchema,
  readerMigrationNoticeInputSchema,
  readerPreferencesInputSchema,
  readerPreferencesSchema,
  readerProgressInputSchema,
  readerProgressSchema,
  readerTitlePreferencesInputSchema,
  staleReaderStateSchema
} from './library';

const revisionId = randomUUID();
const titleId = randomUUID();
const blockId = randomUUID();

describe('reader location contracts', () => {
  it('accepts one discriminated semantic location', () => {
    expect(readerLocationSchema.parse({ format: 'prose', blockId, offset: 8 })).toEqual({
      format: 'prose',
      blockId,
      offset: 8
    });
    expect(
      readerLocationSchema.parse({
        format: 'comic',
        pageId: randomUUID(),
        panelOrdinal: null
      })
    ).toEqual(expect.objectContaining({ format: 'comic', panelOrdinal: null }));
  });

  it.each([
    { format: 'prose', blockId, offset: -1 },
    { format: 'comic', pageId: randomUUID(), panelOrdinal: -1 },
    { format: 'prose', blockId, offset: 0, sheet: 12 },
    { format: 'comic', pageId: 'not-a-uuid', panelOrdinal: null }
  ])('rejects invalid or extra location fields', (value) => {
    expect(() => readerLocationSchema.parse(value)).toThrow();
  });
});

describe('reader mutation contracts', () => {
  it('accepts create-on-first-write version zero and rejects negative versions', () => {
    expect(
      readerProgressInputSchema.parse({
        location: { format: 'prose', blockId, offset: 0 },
        expectedVersion: 0
      })
    ).toEqual(expect.objectContaining({ expectedVersion: 0 }));

    expect(() =>
      readerProgressInputSchema.parse({
        location: { format: 'prose', blockId, offset: 0 },
        expectedVersion: -1
      })
    ).toThrow();
  });

  it('keeps bookmark IDs and migration ownership server-derived', () => {
    expect(
      readerBookmarkInputSchema.parse({ location: { format: 'prose', blockId, offset: 4 } })
    ).toEqual({ location: { format: 'prose', blockId, offset: 4 } });
    expect(() =>
      readerBookmarkInputSchema.parse({
        id: randomUUID(),
        location: { format: 'prose', blockId, offset: 4 }
      })
    ).toThrow();
    expect(() =>
      readerMigrationNoticeInputSchema.parse({ targetRevisionId: revisionId, userId: randomUUID() })
    ).toThrow();
  });

  it.each([14, 18, 24])('accepts bounded font size %s', (fontSize) => {
    expect(
      readerPreferencesInputSchema.parse({
        fontSize,
        typeface: 'serif',
        paper: 'white',
        expectedVersion: 0
      })
    ).toEqual(expect.objectContaining({ fontSize }));
  });

  it.each([
    { fontSize: 13, typeface: 'serif', paper: 'white', expectedVersion: 0 },
    { fontSize: 25, typeface: 'serif', paper: 'white', expectedVersion: 0 },
    { fontSize: 18, typeface: 'dyslexic', paper: 'white', expectedVersion: 0 },
    { fontSize: 18, typeface: 'serif', paper: 'night', expectedVersion: 0 },
    { fontSize: 18, typeface: 'serif', paper: 'white', expectedVersion: 0, userId: titleId }
  ])('rejects out-of-contract preferences', (value) => {
    expect(() => readerPreferencesInputSchema.parse(value)).toThrow();
  });

  it('allows only page or guided comic modes', () => {
    expect(
      readerTitlePreferencesInputSchema.parse({ comicMode: 'guided', expectedVersion: 2 })
    ).toEqual({ comicMode: 'guided', expectedVersion: 2 });
    expect(() =>
      readerTitlePreferencesInputSchema.parse({ comicMode: 'spread', expectedVersion: 2 })
    ).toThrow();
  });
});

describe('reader response contracts', () => {
  const progress = {
    revisionId,
    location: { format: 'prose' as const, blockId, offset: 8 },
    version: 1,
    updatedAt: '2026-08-09T14:15:16.000Z'
  };
  const preferences = {
    fontSize: 18,
    typeface: 'serif' as const,
    paper: 'white' as const,
    version: 0
  };

  it('parses ISO-dated progress and rejects malformed responses', () => {
    expect(readerProgressSchema.parse(progress)).toEqual(progress);
    expect(() => readerProgressSchema.parse({ ...progress, updatedAt: 'yesterday' })).toThrow();
    expect(() => readerProgressSchema.parse({ ...progress, storageKey: 'private/object' })).toThrow();
  });

  it('accepts version-zero account defaults and strict initial state', () => {
    expect(readerPreferencesSchema.parse(preferences)).toEqual(preferences);
    expect(
      readerInitialStateSchema.parse({
        progress,
        bookmarks: [],
        preferences,
        titlePreferences: null,
        migrationNotice: {
          targetRevisionId: revisionId,
          progress: 'migrated',
          panelPositionSimplified: false,
          migratedBookmarkCount: 0,
          unmatchedBookmarkCount: 0,
          acknowledged: false
        }
      })
    ).toEqual(expect.objectContaining({ progress, preferences }));
  });

  it('parses a typed stale-state envelope without accepting extra data', () => {
    const schema = staleReaderStateSchema(readerProgressSchema);
    expect(schema.parse({ code: 'STALE_VERSION', current: progress })).toEqual({
      code: 'STALE_VERSION',
      current: progress
    });
    expect(() =>
      schema.parse({ code: 'STALE_VERSION', current: progress, databaseError: 'secret' })
    ).toThrow();
  });

  it('keeps customer shelf entries free of entitlement and storage details', () => {
    const entry = {
      titleId,
      slug: 'a-book',
      title: 'A Book',
      creatorName: 'An Author',
      format: 'prose' as const,
      coverUrl: null,
      availability: 'available' as const,
      activeRevisionId: revisionId,
      downloadFormat: 'epub' as const,
      progressPercent: 25,
      readUrl: `/read/${titleId}`,
      resumeUrl: `/read/${titleId}`,
      downloadUrl: `/library/${titleId}/download`
    };
    expect(libraryEntrySchema.parse(entry)).toEqual(entry);
    expect(() =>
      libraryEntrySchema.parse({ ...entry, entitlementId: randomUUID(), storageKey: 'private/object' })
    ).toThrow();
  });
});
