import { randomUUID } from 'node:crypto';
import { mkdir, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
  healthProbeKey,
  parseStorageKey,
  revisionComicPageKey,
  revisionCoverSuggestionKey,
  revisionOriginalKey,
  revisionProseImageKey,
  stagingUploadKey,
  titleCoverKey,
  type StorageKey
} from '$lib/server/storage/keys';
import { ownerDatabaseClient, storageCleanupDatabaseClient } from './database';
import { localPathForStorageKey, storage } from './storage';

const checksum = 'a'.repeat(64);

describe('storage cleanup against PostgreSQL references', () => {
  it('deletes only old proven orphans and preserves every protected class', async () => {
    const proseTitleId = randomUUID();
    const comicTitleId = randomUUID();
    const proseRevisionId = randomUUID();
    const comicRevisionId = randomUUID();
    const terminalRevisionId = randomUUID();
    const runningRevisionId = randomUUID();
    const currentCover = titleCoverKey(proseTitleId, randomUUID());
    const referencedStaging = stagingUploadKey(randomUUID());
    const jobReferencedStaging = stagingUploadKey(randomUUID());
    const orphanStaging = stagingUploadKey(randomUUID());
    const terminalStaging = stagingUploadKey(randomUUID());
    const runningJobStaging = stagingUploadKey(randomUUID());
    const retainedOriginal = revisionOriginalKey(proseTitleId, proseRevisionId);
    const crossClassOriginalReference = revisionProseImageKey(
      proseTitleId, proseRevisionId, 2, randomUUID()
    );
    const proseImage = revisionProseImageKey(proseTitleId, proseRevisionId, 0, randomUUID());
    const comicPage = revisionComicPageKey(comicTitleId, comicRevisionId, 0, randomUUID());
    const suggestion = revisionCoverSuggestionKey(proseTitleId, proseRevisionId, 0, randomUUID());
    const orphanDerived = revisionProseImageKey(proseTitleId, proseRevisionId, 1, randomUUID());
    const recentDerived = revisionProseImageKey(proseTitleId, proseRevisionId, 1, randomUUID());
    const activeLegacyDerived = parseStorageKey(
      `titles/${proseTitleId}/revisions/${proseRevisionId}/derived/v1/prose-images/${randomUUID()}.webp`
    );
    const jobLegacyDerived = parseStorageKey(
      `titles/${comicTitleId}/revisions/${comicRevisionId}/derived/v1/comic-pages/${randomUUID()}.webp`
    );
    const terminalLegacyDerived = parseStorageKey(
      `titles/${proseTitleId}/revisions/${terminalRevisionId}/derived/v1/prose-images/${randomUUID()}.webp`
    );
    const orphanCover = titleCoverKey(proseTitleId, randomUUID());
    const oldHealthProbe = healthProbeKey(randomUUID());
    const recentHealthProbe = healthProbeKey(randomUUID());
    const malformedHealthProbe = parseStorageKey('health/probes/not-a-uuid');

    await ownerDatabaseClient.db.insert(titles).values([
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
    await ownerDatabaseClient.db.insert(titleRevisions).values([
      {
        id: proseRevisionId, titleId: proseTitleId, state: 'uploaded',
        createdByActorId: 'admin-1', changeSummary: 'Cleanup proof',
        stagingStorageKey: referencedStaging, stagingChecksumSha256: checksum,
        stagingByteSize: 1, uploadFilename: 'proof.epub',
        uploadMimeType: 'application/epub+zip', originalStorageKey: crossClassOriginalReference,
        originalChecksumSha256: checksum, originalMimeType: 'application/epub+zip',
        originalByteSize: 1, originalFilename: 'proof.epub'
      },
      {
        id: comicRevisionId, titleId: comicTitleId, state: 'failed',
        createdByActorId: 'admin-1', changeSummary: 'Cleanup proof',
        stagingStorageKey: jobReferencedStaging, stagingChecksumSha256: checksum,
        stagingByteSize: 1, uploadFilename: 'proof.cbz', uploadMimeType: 'application/zip'
      },
      {
        id: terminalRevisionId, titleId: proseTitleId, state: 'failed',
        createdByActorId: 'admin-1', changeSummary: 'Terminal cleanup proof',
        stagingStorageKey: terminalStaging, stagingChecksumSha256: checksum,
        stagingByteSize: 1, uploadFilename: 'terminal.epub',
        uploadMimeType: 'application/epub+zip'
      },
      {
        id: runningRevisionId, titleId: comicTitleId, state: 'failed',
        ingestionGeneration: 3,
        createdByActorId: 'admin-1', changeSummary: 'Running cleanup proof',
        stagingStorageKey: runningJobStaging, stagingChecksumSha256: checksum,
        stagingByteSize: 1, uploadFilename: 'running.cbz', uploadMimeType: 'application/zip'
      }
    ]);
    await ownerDatabaseClient.db.insert(jobs).values([
      {
        type: 'catalog.ingest_revision', status: 'pending',
        payload: { revisionId: comicRevisionId, generation: 0 },
        deduplicationKey: `cleanup:${comicRevisionId}`
      },
      {
        type: 'catalog.ingest_revision', status: 'running',
        payload: { revisionId: runningRevisionId, generation: 3 },
        deduplicationKey: `cleanup:${runningRevisionId}:3`,
        lockedAt: new Date(), lockedBy: 'storage-cleanup-running-witness'
      }
    ]);
    await ownerDatabaseClient.db.insert(proseImages).values({
      revisionId: proseRevisionId, storageKey: proseImage, mediaType: 'image/webp',
      checksumSha256: checksum, byteSize: 1, width: 1, height: 1
    });
    await ownerDatabaseClient.db.insert(comicPages).values({
      revisionId: comicRevisionId, ordinal: 1, sourcePath: '001.png', storageKey: comicPage,
      mediaType: 'image/webp', checksumSha256: checksum, byteSize: 1, width: 1, height: 1
    });
    await ownerDatabaseClient.db.insert(revisionCoverSuggestions).values({
      revisionId: proseRevisionId, storageKey: suggestion, sourceDescription: 'cover',
      mediaType: 'image/webp', checksumSha256: checksum, byteSize: 1, width: 1, height: 1
    });

    const oldKeys: StorageKey[] = [
      currentCover, referencedStaging, jobReferencedStaging, orphanStaging, retainedOriginal,
      terminalStaging, runningJobStaging, proseImage, comicPage, suggestion,
      orphanDerived, orphanCover,
      activeLegacyDerived, jobLegacyDerived, terminalLegacyDerived, crossClassOriginalReference,
      oldHealthProbe
    ];
    for (const key of [...oldKeys, recentDerived, recentHealthProbe]) {
      await storage.write(key, Readable.from(['x']), { maxBytes: 1 });
    }
    const malformedHealthPath = localPathForStorageKey(malformedHealthProbe);
    await mkdir(dirname(malformedHealthPath), { recursive: true });
    await writeFile(malformedHealthPath, 'x', { flag: 'wx' });
    const oldDate = new Date('2026-07-01T00:00:00.000Z');
    for (const key of oldKeys) {
      await utimes(localPathForStorageKey(key), oldDate, oldDate);
    }
    await utimes(malformedHealthPath, oldDate, oldDate);
    const recentDate = new Date('2026-08-09T11:00:00.000Z');
    for (const key of [recentDerived, recentHealthProbe]) {
      await utimes(localPathForStorageKey(key), recentDate, recentDate);
    }

    const summary = await cleanupStorage({
      database: storageCleanupDatabaseClient.db,
      storage,
      config: { stagingRetentionHours: 24, orphanRetentionHours: 168 },
      mode: 'apply',
      now: new Date('2026-08-09T12:00:00.000Z'),
      log: () => undefined
    });

    expect(summary).toMatchObject({ candidates: 6, deleted: 6, deletedBytes: 6 });
    for (const key of [
      orphanStaging, terminalStaging, orphanDerived, orphanCover, terminalLegacyDerived,
      oldHealthProbe
    ]) {
      expect(await storage.stat(key)).toBeNull();
    }
    for (const key of [
      currentCover, referencedStaging, jobReferencedStaging, runningJobStaging, retainedOriginal,
      proseImage, comicPage, suggestion, recentDerived, activeLegacyDerived, jobLegacyDerived,
      crossClassOriginalReference, recentHealthProbe
    ]) {
      expect(await storage.stat(parseStorageKey(key))).not.toBeNull();
    }
    expect((await stat(malformedHealthPath)).size).toBe(1);
  });
});
