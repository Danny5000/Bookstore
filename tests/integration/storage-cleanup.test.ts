import { randomUUID } from 'node:crypto';
import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { cleanupStorage } from '$lib/server/storage/cleanup';
import {
  comicPages,
  jobs,
  proseImages,
  revisionCoverSuggestions,
  titleRevisions,
  titles
} from '$lib/server/db/schema';
import {
  parseStorageKey,
  revisionComicPageKey,
  revisionCoverSuggestionKey,
  revisionOriginalKey,
  revisionProseImageKey,
  stagingUploadKey,
  titleCoverKey,
  type StorageKey
} from '$lib/server/storage/keys';
import { createLocalObjectStorage } from '$lib/server/storage/local';
import { databaseClient } from './database';

const checksum = 'a'.repeat(64);

describe('storage cleanup against PostgreSQL references', () => {
  it('deletes only old proven orphans and preserves every protected class', async () => {
    const root = process.env.STORAGE_LOCAL_ROOT!;
    const storage = createLocalObjectStorage(root);
    const proseTitleId = randomUUID();
    const comicTitleId = randomUUID();
    const proseRevisionId = randomUUID();
    const comicRevisionId = randomUUID();
    const currentCover = titleCoverKey(proseTitleId, randomUUID());
    const referencedStaging = stagingUploadKey(randomUUID());
    const jobReferencedStaging = stagingUploadKey(randomUUID());
    const orphanStaging = stagingUploadKey(randomUUID());
    const retainedOriginal = revisionOriginalKey(proseTitleId, proseRevisionId);
    const proseImage = revisionProseImageKey(proseTitleId, proseRevisionId, randomUUID());
    const comicPage = revisionComicPageKey(comicTitleId, comicRevisionId, randomUUID());
    const suggestion = revisionCoverSuggestionKey(proseTitleId, proseRevisionId, randomUUID());
    const orphanDerived = revisionProseImageKey(proseTitleId, proseRevisionId, randomUUID());
    const recentDerived = revisionProseImageKey(proseTitleId, proseRevisionId, randomUUID());
    const orphanCover = titleCoverKey(proseTitleId, randomUUID());

    await databaseClient.db.insert(titles).values([
      {
        id: proseTitleId, slug: `cleanup-prose-${randomUUID()}`, title: 'Cleanup prose',
        description: 'Cleanup proof', creatorName: 'Pale Orbit', format: 'prose',
        priceMinor: 100, currency: 'USD', coverStorageKey: currentCover,
        coverMediaType: 'image/webp', coverChecksumSha256: checksum, coverByteSize: 1,
        coverWidth: 1, coverHeight: 1, coverUpdatedAt: new Date()
      },
      {
        id: comicTitleId, slug: `cleanup-comic-${randomUUID()}`, title: 'Cleanup comic',
        description: 'Cleanup proof', creatorName: 'Pale Orbit', format: 'comic',
        priceMinor: 100, currency: 'USD'
      }
    ]);
    await databaseClient.db.insert(titleRevisions).values([
      {
        id: proseRevisionId, titleId: proseTitleId, state: 'uploaded',
        createdByActorId: 'admin-1', changeSummary: 'Cleanup proof',
        stagingStorageKey: referencedStaging, stagingChecksumSha256: checksum,
        stagingByteSize: 1, uploadFilename: 'proof.epub',
        uploadMimeType: 'application/epub+zip', originalStorageKey: retainedOriginal,
        originalChecksumSha256: checksum, originalMimeType: 'application/epub+zip',
        originalByteSize: 1, originalFilename: 'proof.epub'
      },
      {
        id: comicRevisionId, titleId: comicTitleId, state: 'failed',
        createdByActorId: 'admin-1', changeSummary: 'Cleanup proof',
        stagingStorageKey: jobReferencedStaging, stagingChecksumSha256: checksum,
        stagingByteSize: 1, uploadFilename: 'proof.cbz', uploadMimeType: 'application/zip'
      }
    ]);
    await databaseClient.db.insert(jobs).values({
      type: 'catalog.ingest_revision', status: 'pending',
      payload: { revisionId: comicRevisionId, generation: 0 },
      deduplicationKey: `cleanup:${comicRevisionId}`
    });
    await databaseClient.db.insert(proseImages).values({
      revisionId: proseRevisionId, storageKey: proseImage, mediaType: 'image/webp',
      checksumSha256: checksum, byteSize: 1, width: 1, height: 1
    });
    await databaseClient.db.insert(comicPages).values({
      revisionId: comicRevisionId, ordinal: 1, sourcePath: '001.png', storageKey: comicPage,
      mediaType: 'image/webp', checksumSha256: checksum, byteSize: 1, width: 1, height: 1
    });
    await databaseClient.db.insert(revisionCoverSuggestions).values({
      revisionId: proseRevisionId, storageKey: suggestion, sourceDescription: 'cover',
      mediaType: 'image/webp', checksumSha256: checksum, byteSize: 1, width: 1, height: 1
    });

    const oldKeys: StorageKey[] = [
      currentCover, referencedStaging, jobReferencedStaging, orphanStaging, retainedOriginal,
      proseImage, comicPage, suggestion, orphanDerived, orphanCover
    ];
    for (const key of [...oldKeys, recentDerived]) {
      await storage.write(key, Readable.from(['x']), { maxBytes: 1 });
    }
    const oldDate = new Date('2026-07-01T00:00:00.000Z');
    for (const key of oldKeys) {
      await utimes(join(root, ...key.split('/')), oldDate, oldDate);
    }

    const summary = await cleanupStorage({
      database: databaseClient.db,
      storage,
      config: { stagingRetentionHours: 24, orphanRetentionHours: 168 },
      mode: 'apply',
      now: new Date('2026-08-09T12:00:00.000Z'),
      log: () => undefined
    });

    expect(summary).toMatchObject({ candidates: 3, deleted: 3, deletedBytes: 3 });
    for (const key of [orphanStaging, orphanDerived, orphanCover]) {
      expect(await storage.stat(key)).toBeNull();
    }
    for (const key of [
      currentCover, referencedStaging, jobReferencedStaging, retainedOriginal,
      proseImage, comicPage, suggestion, recentDerived
    ]) {
      expect(await storage.stat(parseStorageKey(key))).not.toBeNull();
    }
  });
});
