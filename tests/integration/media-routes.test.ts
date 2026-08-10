import { randomUUID } from 'node:crypto';
import { count, eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import {
  MediaNotFoundError,
  resolveCustomerOriginalDownload,
  resolveReaderImageAccess
} from '$lib/server/catalog/media';
import {
  auditEvents,
  entitlements,
  proseBlocks,
  proseImages,
  proseSections,
  revisionPresentations,
  titleRevisions,
  titles,
  user
} from '$lib/server/db/schema';
import { revisionOriginalKey, revisionProseImageKey } from '$lib/server/storage/keys';
import type { ObjectStorage } from '$lib/server/storage/types';
import { databaseClient } from './database';

const adminId = randomUUID();
const checksum = 'a'.repeat(64);

async function createCustomer(): Promise<Extract<Actor, { type: 'user' }>> {
  const id = randomUUID();
  await databaseClient.db.insert(user).values({
    id,
    name: 'Media Customer',
    email: `${id}@example.com`,
    emailVerified: true
  });
  return { type: 'user', id, roles: ['customer'] };
}

async function createPublication() {
  const [title] = await databaseClient.db
    .insert(titles)
    .values({
      slug: `media-${randomUUID()}`,
      title: 'Archived Reader',
      description: 'Entitled media fixture',
      creatorName: 'Pale Orbit',
      format: 'prose',
      priceMinor: 1299,
      currency: 'USD',
      visibility: 'archived'
    })
    .returning();
  if (!title) throw new Error('Expected title');
  const revisionId = randomUUID();
  const [revision] = await databaseClient.db
    .insert(titleRevisions)
    .values({
      id: revisionId,
      titleId: title.id,
      state: 'active',
      createdByActorId: adminId,
      changeSummary: 'Media fixture',
      originalStorageKey: revisionOriginalKey(title.id, revisionId),
      originalChecksumSha256: checksum,
      originalMimeType: 'application/epub+zip',
      originalByteSize: 100,
      originalFilename: 'private-source-name.epub'
    })
    .returning();
  if (!revision) throw new Error('Expected revision');
  const [section] = await databaseClient.db
    .insert(proseSections)
    .values({
      revisionId: revision.id,
      ordinal: 0,
      label: 'Chapter',
      sourceReference: 'EPUB/chapter.xhtml'
    })
    .returning();
  if (!section) throw new Error('Expected section');
  const previewImageId = randomUUID();
  const fullImageId = randomUUID();
  await databaseClient.db.insert(proseImages).values([
    {
      id: previewImageId,
      revisionId: revision.id,
      storageKey: revisionProseImageKey(title.id, revision.id, previewImageId),
      mediaType: 'image/webp',
      checksumSha256: checksum,
      byteSize: 100,
      width: 10,
      height: 10,
      altText: 'Preview image'
    },
    {
      id: fullImageId,
      revisionId: revision.id,
      storageKey: revisionProseImageKey(title.id, revision.id, fullImageId),
      mediaType: 'image/webp',
      checksumSha256: checksum,
      byteSize: 100,
      width: 10,
      height: 10,
      altText: 'Full image'
    }
  ]);
  const previewBlockId = randomUUID();
  await databaseClient.db.insert(proseBlocks).values([
    {
      id: previewBlockId,
      revisionId: revision.id,
      sectionId: section.id,
      ordinal: 0,
      kind: 'image',
      content: { kind: 'image', imageId: previewImageId, alt: 'Preview image' },
      imageId: previewImageId
    },
    {
      revisionId: revision.id,
      sectionId: section.id,
      ordinal: 1,
      kind: 'image',
      content: { kind: 'image', imageId: fullImageId, alt: 'Full image' },
      imageId: fullImageId
    }
  ]);
  await databaseClient.db.insert(revisionPresentations).values({
    revisionId: revision.id,
    state: 'published',
    previewProseSectionId: section.id,
    previewProseBlockId: previewBlockId,
    previewComicPageId: null
  });
  await databaseClient.db
    .update(titles)
    .set({ activeRevisionId: revision.id })
    .where(eq(titles.id, title.id));

  const candidateRevisionId = randomUUID();
  await databaseClient.db.insert(titleRevisions).values({
    id: candidateRevisionId,
    titleId: title.id,
    state: 'ready_for_review',
    createdByActorId: adminId,
    changeSummary: 'Candidate fixture'
  });
  const candidateImageId = randomUUID();
  await databaseClient.db.insert(proseImages).values({
    id: candidateImageId,
    revisionId: candidateRevisionId,
    storageKey: revisionProseImageKey(title.id, candidateRevisionId, candidateImageId),
    mediaType: 'image/webp',
    checksumSha256: checksum,
    byteSize: 100,
    width: 10,
    height: 10,
    altText: 'Candidate image'
  });
  return { title, revision, previewImageId, fullImageId, candidateRevisionId, candidateImageId };
}

function storage(): ObjectStorage {
  return {
    stat: vi.fn(async () => ({ byteSize: 100, modifiedAt: new Date(0) }))
  } as unknown as ObjectStorage;
}

describe('entitled media and original download resolution', () => {
  it('rechecks current access, keeps full assets private, and writes one redacted audit event', async () => {
    const customer = await createCustomer();
    const publication = await createPublication();
    await databaseClient.db.insert(entitlements).values({
      userId: customer.id,
      titleId: publication.title.id
    });
    const objectStorage = storage();

    await expect(
      resolveReaderImageAccess(databaseClient.db, objectStorage, customer, {
        revisionId: publication.revision.id,
        imageId: publication.fullImageId,
        checksum
      })
    ).resolves.toMatchObject({ cacheControl: 'private, no-store' });
    await expect(
      resolveReaderImageAccess(databaseClient.db, objectStorage, customer, {
        revisionId: publication.candidateRevisionId,
        imageId: publication.candidateImageId,
        checksum
      })
    ).rejects.toBeInstanceOf(MediaNotFoundError);

    const download = await resolveCustomerOriginalDownload(
      databaseClient.db,
      objectStorage,
      customer,
      {
        titleId: publication.title.id,
        correlationId: 'customer-range-download',
        rangeRequested: true,
        requestMetadata: { method: 'GET', routeId: '/library/[titleId]/download' }
      }
    );
    expect(download).toMatchObject({
      titleId: publication.title.id,
      revisionId: publication.revision.id,
      access: {
        filename: 'Archived Reader.epub',
        mediaType: 'application/epub+zip',
        cacheControl: 'private, no-store'
      }
    });
    const events = await databaseClient.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'library.original.download'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: 'user',
      actorId: customer.id,
      outcome: 'succeeded',
      resourceType: 'title_revision',
      resourceId: publication.revision.id,
      correlationId: 'customer-range-download',
      after: {
        titleId: publication.title.id,
        activeRevisionId: publication.revision.id,
        range: true
      }
    });
    expect(JSON.stringify(events[0])).not.toMatch(
      /private-source-name|originalStorageKey|filename|cookie|token|authorization/iu
    );

    await databaseClient.db
      .update(entitlements)
      .set({ revokedAt: sql`clock_timestamp()` })
      .where(eq(entitlements.userId, customer.id));
    await expect(
      resolveCustomerOriginalDownload(databaseClient.db, objectStorage, customer, {
        titleId: publication.title.id,
        correlationId: 'revoked-download',
        rangeRequested: false
      })
    ).rejects.toBeInstanceOf(MediaNotFoundError);
    const [auditCount] = await databaseClient.db
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.action, 'library.original.download'));
    expect(auditCount?.value).toBe(1);

    await databaseClient.db
      .update(titles)
      .set({ visibility: 'public' })
      .where(eq(titles.id, publication.title.id));
    await expect(
      resolveReaderImageAccess(databaseClient.db, objectStorage, customer, {
        revisionId: publication.revision.id,
        imageId: publication.previewImageId,
        checksum
      })
    ).resolves.toMatchObject({ cacheControl: 'public, max-age=31536000, immutable' });
    await expect(
      resolveReaderImageAccess(databaseClient.db, objectStorage, customer, {
        revisionId: publication.revision.id,
        imageId: publication.fullImageId,
        checksum
      })
    ).rejects.toBeInstanceOf(MediaNotFoundError);
  });
});
