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
import { lockEntitlementScopes } from '$lib/server/commerce/lock';
import { revisionOriginalKey, revisionProseImageKey } from '$lib/server/storage/keys';
import type { ObjectStorage } from '$lib/server/storage/types';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { databaseClient, ownerDatabaseClient, workerDatabaseClient } from './database';

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
  await workerDatabaseClient.db.transaction((transaction) =>
    setPreservedGrantState(transaction, {
      userId,
      titleId,
      active: true,
      stateReason: 'test_preserved_access'
    })
  );
}

async function revoke(userId: string, titleId: string): Promise<void> {
  await workerDatabaseClient.db.transaction((transaction) =>
    setPreservedGrantState(transaction, {
      userId,
      titleId,
      active: false,
      stateReason: 'test_preserved_revoked'
    })
  );
}

async function createPublication() {
  const [title] = await ownerDatabaseClient.db
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
  const [revision] = await ownerDatabaseClient.db
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
  const [section] = await ownerDatabaseClient.db
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
  await ownerDatabaseClient.db.insert(proseImages).values([
    {
      id: previewImageId,
      revisionId: revision.id,
      storageKey: revisionProseImageKey(
        title.id,
        revision.id,
        revision.ingestionGeneration,
        previewImageId
      ),
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
      storageKey: revisionProseImageKey(
        title.id,
        revision.id,
        revision.ingestionGeneration,
        fullImageId
      ),
      mediaType: 'image/webp',
      checksumSha256: checksum,
      byteSize: 100,
      width: 10,
      height: 10,
      altText: 'Full image'
    }
  ]);
  const previewBlockId = randomUUID();
  await ownerDatabaseClient.db.insert(proseBlocks).values([
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
  await ownerDatabaseClient.db.insert(revisionPresentations).values({
    revisionId: revision.id,
    state: 'published',
    previewProseSectionId: section.id,
    previewProseBlockId: previewBlockId,
    previewComicPageId: null
  });
  await ownerDatabaseClient.db
    .update(titles)
    .set({ activeRevisionId: revision.id })
    .where(eq(titles.id, title.id));

  const candidateRevisionId = randomUUID();
  await ownerDatabaseClient.db.insert(titleRevisions).values({
    id: candidateRevisionId,
    titleId: title.id,
    state: 'ready_for_review',
    createdByActorId: adminId,
    changeSummary: 'Candidate fixture'
  });
  const candidateImageId = randomUUID();
  await ownerDatabaseClient.db.insert(proseImages).values({
    id: candidateImageId,
    revisionId: candidateRevisionId,
    storageKey: revisionProseImageKey(title.id, candidateRevisionId, 0, candidateImageId),
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

function namedTransactionDatabase(applicationName: string): Database {
  return {
    transaction: <T>(work: (transaction: DatabaseTransaction) => Promise<T>) =>
      databaseClient.db.transaction(async (transaction) => {
        await transaction.execute(
          sql`select set_config('application_name', ${applicationName}, true)`
        );
        return work(transaction);
      })
  } as unknown as Database;
}

async function waitForNamedBlockedEntitlementQuery(
  blockedApplicationName: string,
  blockerApplicationName: string
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await ownerDatabaseClient.pool.query<{ blocked: boolean }>(`
      select exists (
        select 1
        from pg_stat_activity blocked_activity
        cross join lateral unnest(pg_blocking_pids(blocked_activity.pid)) blocking(pid)
        inner join pg_stat_activity blocker_activity on blocker_activity.pid = blocking.pid
        where blocked_activity.datname = current_database()
          and blocked_activity.application_name = $1
          and blocker_activity.application_name = $2
          and blocked_activity.wait_event_type = 'Lock'
          and blocked_activity.query ilike '%pg_advisory_xact_lock%'
      ) as blocked
    `, [blockedApplicationName, blockerApplicationName]);
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected the download authorization query to wait for entitlement projection');
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
    const downloadApplicationName = `media-download-${randomUUID()}`;
    const revocationApplicationName = `media-revocation-${randomUUID()}`;
    const requestDatabase = namedTransactionDatabase(downloadApplicationName);
    let releaseRevocation!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseRevocation = resolve;
    });
    let signalRevocationPrepared!: () => void;
    const revocationPrepared = new Promise<void>((resolve) => {
      signalRevocationPrepared = resolve;
    });
    const revocation = workerDatabaseClient.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select set_config('application_name', ${revocationApplicationName}, true)`
      );
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
        requestDatabase,
        objectStorage,
        customer,
        {
          titleId: publication.title.id,
          correlationId: 'concurrent-revocation',
          method: 'GET',
          rangeHeader: null
        }
      );
      await waitForNamedBlockedEntitlementQuery(
        downloadApplicationName,
        revocationApplicationName
      );
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

  it('waits on entitlement scope before row locks so a pending worker grant can finish', async () => {
    const customer = await createCustomer();
    const publication = await createPublication();
    const objectStorage = storage();
    const downloadApplicationName = `media-grant-read-${randomUUID()}`;
    const projectionApplicationName = `media-grant-work-${randomUUID()}`;
    const requestDatabase = namedTransactionDatabase(downloadApplicationName);
    let releaseProjection!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    let signalScopeLocked!: () => void;
    const scopeLocked = new Promise<void>((resolve) => {
      signalScopeLocked = resolve;
    });
    const projection = workerDatabaseClient.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select set_config('application_name', ${projectionApplicationName}, true)`
      );
      await lockEntitlementScopes(transaction, [{
        userId: customer.id,
        titleId: publication.title.id
      }]);
      signalScopeLocked();
      await release;
      return setPreservedGrantState(transaction, {
        userId: customer.id,
        titleId: publication.title.id,
        active: true,
        stateReason: 'test_pending_grant_projection'
      });
    });
    void projection.catch(() => undefined);
    let download: Promise<Response> | undefined;
    let released = false;
    try {
      await scopeLocked;
      download = streamCustomerOriginalDownload(
        requestDatabase,
        objectStorage,
        customer,
        {
          titleId: publication.title.id,
          correlationId: 'pending-grant-lock-order',
          method: 'HEAD',
          rangeHeader: null
        }
      );
      void download.catch(() => undefined);
      await waitForNamedBlockedEntitlementQuery(
        downloadApplicationName,
        projectionApplicationName
      );

      releaseProjection();
      released = true;
      await expect(projection).resolves.toEqual({ beforeActive: false, afterActive: true });
      const response = await download;
      expect(response.status).toBe(200);
      expect(objectStorage.prepareVerifiedRead).not.toHaveBeenCalled();
    } finally {
      if (!released) releaseProjection();
      await Promise.allSettled([projection, ...(download ? [download] : [])]);
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
