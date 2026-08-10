import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { count, eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import {
  MediaNotFoundError,
  resolveReaderImageAccess,
  streamCustomerOriginalDownload
} from '$lib/server/catalog/media';
import {
  auditEvents,
  proseBlocks,
  proseImages,
  proseSections,
  revisionPresentations,
  titleRevisions,
  titles,
  user
} from '$lib/server/db/schema';
import { setPreservedGrantState } from '$lib/server/commerce/grants';
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

async function grant(userId: string, titleId: string): Promise<void> {
  await databaseClient.db.transaction((transaction) =>
    setPreservedGrantState(transaction, {
      userId,
      titleId,
      active: true,
      stateReason: 'test_preserved_access'
    })
  );
}

async function revoke(userId: string, titleId: string): Promise<void> {
  await databaseClient.db.transaction((transaction) =>
    setPreservedGrantState(transaction, {
      userId,
      titleId,
      active: false,
      stateReason: 'test_preserved_revoked'
    })
  );
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

function storage(options: { prepareFailure?: Error } = {}): ObjectStorage {
  return {
    stat: vi.fn(async () => ({ byteSize: 100, modifiedAt: new Date(0) })),
    prepareVerifiedRead: vi.fn(async () => {
      if (options.prepareFailure) throw options.prepareFailure;
      return {
        stat: { byteSize: 100, modifiedAt: new Date(0) },
        read: vi.fn(async (range?: { start: number; endInclusive: number }) =>
          Readable.from([Buffer.alloc(range ? range.endInclusive - range.start + 1 : 100)])),
        close: vi.fn(async () => undefined)
      };
    })
  } as unknown as ObjectStorage;
}

async function waitForBlockedEntitlementQuery(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await databaseClient.pool.query<{ blocked: boolean }>(`
      select exists (
        select 1
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'
          and query ilike '%entitlements%'
      ) as blocked
    `);
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected the download authorization query to wait for entitlement revocation');
}

describe('entitled media and original download resolution', () => {
  it('rechecks current access, keeps full assets private, and writes one redacted audit event', async () => {
    const customer = await createCustomer();
    const publication = await createPublication();
    await grant(customer.id, publication.title.id);
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

    const download = await streamCustomerOriginalDownload(
      databaseClient.db,
      objectStorage,
      customer,
      {
        titleId: publication.title.id,
        correlationId: 'customer-range-download',
        method: 'HEAD',
        rangeHeader: 'bytes=0-9'
      }
    );
    expect(download.status).toBe(206);
    expect(download.headers.get('content-disposition')).toContain('Archived%20Reader.epub');
    expect(download.headers.get('content-type')).toBe('application/epub+zip');
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
      requestMetadata: null,
      after: {
        titleId: publication.title.id,
        activeRevisionId: publication.revision.id,
        range: true
      }
    });
    expect(JSON.stringify(events[0])).not.toMatch(
      /private-source-name|originalStorageKey|filename|cookie|token|authorization/iu
    );

    await revoke(customer.id, publication.title.id);
    await expect(
      streamCustomerOriginalDownload(databaseClient.db, objectStorage, customer, {
        titleId: publication.title.id,
        correlationId: 'revoked-download',
        method: 'GET',
        rangeHeader: null
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

  it('serializes stream-start authorization against concurrent entitlement revocation', async () => {
    const customer = await createCustomer();
    const publication = await createPublication();
    await grant(customer.id, publication.title.id);
    const objectStorage = storage();
    let releaseRevocation!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseRevocation = resolve;
    });
    let signalRevocationPrepared!: () => void;
    const revocationPrepared = new Promise<void>((resolve) => {
      signalRevocationPrepared = resolve;
    });
    const revocation = databaseClient.db.transaction(async (transaction) => {
      await setPreservedGrantState(transaction, {
        userId: customer.id,
        titleId: publication.title.id,
        active: false,
        stateReason: 'test_concurrent_revocation'
      });
      signalRevocationPrepared();
      await release;
    });
    try {
      await revocationPrepared;
      const download = streamCustomerOriginalDownload(
        databaseClient.db,
        objectStorage,
        customer,
        {
          titleId: publication.title.id,
          correlationId: 'concurrent-revocation',
          method: 'GET',
          rangeHeader: null
        }
      );
      await waitForBlockedEntitlementQuery();
      expect(objectStorage.prepareVerifiedRead).not.toHaveBeenCalled();

      releaseRevocation();
      await revocation;
      await expect(download).rejects.toBeInstanceOf(MediaNotFoundError);
      const events = await databaseClient.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.correlationId, 'concurrent-revocation'));
      expect(events).toHaveLength(0);
      expect(objectStorage.prepareVerifiedRead).not.toHaveBeenCalled();
    } finally {
      releaseRevocation();
      await Promise.allSettled([revocation]);
    }
  });

  it('prepares the verified snapshot without holding entitlement locks, then rechecks access', async () => {
    const customer = await createCustomer();
    const publication = await createPublication();
    await grant(customer.id, publication.title.id);
    let markPrepareStarted!: () => void;
    const prepareStarted = new Promise<void>((resolve) => { markPrepareStarted = resolve; });
    let releasePrepare!: () => void;
    const prepareGate = new Promise<void>((resolve) => { releasePrepare = resolve; });
    const objectStorage = storage();
    const close = vi.fn(async () => undefined);
    vi.mocked(objectStorage.prepareVerifiedRead).mockImplementationOnce(async () => {
      markPrepareStarted();
      await prepareGate;
      return {
        stat: { byteSize: 100, modifiedAt: new Date(0) },
        read: vi.fn(async () => Readable.from([Buffer.alloc(100)])),
        close
      };
    });
    const download = streamCustomerOriginalDownload(
      databaseClient.db,
      objectStorage,
      customer,
      {
        titleId: publication.title.id,
        correlationId: 'download-wins-revocation-race',
        method: 'GET',
        rangeHeader: null
      }
    );
    await prepareStarted;

    let revocation: Promise<unknown> | undefined;
    try {
      revocation = revoke(customer.id, publication.title.id);
      const revocationSettled = await Promise.race([
        revocation.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 250))
      ]);
      expect(revocationSettled).toBe(true);
      expect(objectStorage.prepareVerifiedRead).toHaveBeenCalledOnce();

      releasePrepare();
      await expect(download).rejects.toBeInstanceOf(MediaNotFoundError);
      const events = await databaseClient.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.correlationId, 'download-wins-revocation-race'));
      expect(events).toHaveLength(0);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      releasePrepare();
      await Promise.allSettled([download, ...(revocation ? [revocation] : [])]);
    }
  });

  it('does not commit success audit for invalid ranges or synchronous storage failures', async () => {
    const customer = await createCustomer();
    const publication = await createPublication();
    await grant(customer.id, publication.title.id);

    const invalidRange = await streamCustomerOriginalDownload(
      databaseClient.db,
      storage(),
      customer,
      {
        titleId: publication.title.id,
        correlationId: 'invalid-range-no-audit',
        method: 'GET',
        rangeHeader: 'bytes=200-'
      }
    );
    expect(invalidRange.status).toBe(416);

    await expect(
      streamCustomerOriginalDownload(
        databaseClient.db,
        storage({ prepareFailure: new Error('temporary provider failure') }),
        customer,
        {
          titleId: publication.title.id,
          correlationId: 'storage-failure-no-audit',
          method: 'GET',
          rangeHeader: null
        }
      )
    ).rejects.toThrow('temporary provider failure');
    const failedEvents = await databaseClient.db
      .select()
      .from(auditEvents)
      .where(
        sql`${auditEvents.correlationId} in ('invalid-range-no-audit', 'storage-failure-no-audit')`
      );
    expect(failedEvents).toHaveLength(0);
  });
});
